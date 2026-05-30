"""FastAPI application for the Kiwi morphological analyzer service.

Routes:
    POST /lemmatize  -> tokens with offsets
    POST /tokens     -> tokens without offsets (lighter)
    GET  /health     -> liveness + model-loaded flag
    GET  /version    -> Kiwi + service version

Lifecycle:
    The Kiwi model is loaded once during the FastAPI `lifespan` startup hook
    and held on `app.state.lemmatizer`. Endpoints retrieve it via a Depends
    function — that makes overriding it in tests one line.

Concurrency model:
    Kiwi is CPU-bound. The endpoint functions are `async def` but offload
    `lemmatizer.lemmatize` via `run_in_threadpool` so a slow request doesn't
    block the event loop. (FastAPI does that automatically for sync
    dependencies, but we want to keep the route async to add structured
    request logging without yielding work to a thread when there's nothing
    to do.)
"""

from __future__ import annotations

import time
import uuid
from contextlib import asynccontextmanager
from typing import AsyncIterator

import structlog
from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from kiwi_service import __version__ as SERVICE_VERSION
from kiwi_service.config import Settings, get_settings
from kiwi_service.lemmatizer import (
    AnalyzedToken,
    LemmatizationError,
    Lemmatizer,
    configure_stdlib_logging,
)
from kiwi_service.models import (
    ErrorResponse,
    HealthResponse,
    LemmatizeRequest,
    LemmatizeResponse,
    LightToken,
    Token,
    TokensResponse,
    VersionResponse,
)

log = structlog.get_logger(__name__)


# ---------------------------------------------------------------------------
# structlog bootstrap — JSON logs, ISO timestamps, level + logger name.
# Called once at import; idempotent.
# ---------------------------------------------------------------------------


def _configure_structlog(level: str) -> None:
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", utc=True),
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(_level_to_int(level)),
        cache_logger_on_first_use=True,
    )


def _level_to_int(level: str) -> int:
    import logging as _logging

    return _logging.getLevelName(level.upper())  # type: ignore[no-any-return]


# ---------------------------------------------------------------------------
# Lifespan: load Kiwi at startup; release on shutdown.
# ---------------------------------------------------------------------------


@asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings: Settings = app.state.settings
    configure_stdlib_logging(settings.log_level)
    _configure_structlog(settings.log_level)

    log.info(
        "service.starting",
        service=settings.service_name,
        version=SERVICE_VERSION,
        model_size=settings.model_size,
    )
    # Loading the model is sync + slow (hundreds of ms). Doing it on the event
    # loop is fine because startup is the only time we do it.
    lemmatizer = Lemmatizer(model_size=settings.model_size)
    app.state.lemmatizer = lemmatizer
    log.info("service.ready")
    try:
        yield
    finally:
        log.info("service.shutting_down")


# ---------------------------------------------------------------------------
# App factory
# ---------------------------------------------------------------------------


def create_app(settings: Settings | None = None) -> FastAPI:
    """Construct the FastAPI app. Factory pattern so tests can pass a custom
    `Settings` (e.g. lower max_input_chars).
    """
    settings = settings or get_settings()

    app = FastAPI(
        title="Kiwi Morphological Analyzer",
        version=SERVICE_VERSION,
        # Docs are useful for the gateway dev; harmless since the service is
        # on the internal compose network only.
        docs_url="/docs",
        redoc_url=None,
        openapi_url="/openapi.json",
        lifespan=_lifespan,
    )
    app.state.settings = settings

    _register_middleware(app)
    _register_routes(app)
    _register_exception_handlers(app)
    return app


# ---------------------------------------------------------------------------
# Middleware: request-id + access log
# ---------------------------------------------------------------------------


def _register_middleware(app: FastAPI) -> None:
    @app.middleware("http")
    async def request_context(request: Request, call_next):  # type: ignore[no-untyped-def]
        # Honor a request ID from B3 (Express) if present, else mint one.
        req_id = request.headers.get("x-request-id") or uuid.uuid4().hex
        structlog.contextvars.bind_contextvars(request_id=req_id, path=request.url.path)
        start = time.perf_counter()
        response = None
        try:
            response = await call_next(request)
            response.headers["x-request-id"] = req_id
            return response
        finally:
            duration_ms = (time.perf_counter() - start) * 1000
            log.info(
                "http.request",
                method=request.method,
                status_code=getattr(response, "status_code", 500),
                duration_ms=round(duration_ms, 2),
            )
            structlog.contextvars.clear_contextvars()


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


def _get_lemmatizer(request: Request) -> Lemmatizer:
    lemmatizer: Lemmatizer | None = getattr(request.app.state, "lemmatizer", None)
    if lemmatizer is None or not lemmatizer.model_loaded:
        # Should never happen post-startup — but if /health is called before
        # the lifespan startup finishes we surface that honestly.
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Kiwi model not yet loaded",
        )
    return lemmatizer


def _get_settings_dep(request: Request) -> Settings:
    return request.app.state.settings  # type: ignore[no-any-return]


def _enforce_input_limit(text: str, settings: Settings) -> None:
    """Reject oversized input at the boundary (DoS defense T1 in SECURITY.md).

    Pydantic validates a fixed default; the env-configurable hard limit lives
    here so ops can tighten without redeploying images.
    """
    if len(text) > settings.max_input_chars:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=(
                f"text exceeds {settings.max_input_chars}-char limit "
                "(KIWI_MAX_INPUT_CHARS). Chunk by sentence on the client."
            ),
        )


def _register_routes(app: FastAPI) -> None:
    @app.get("/health", response_model=HealthResponse, tags=["meta"])
    async def health(request: Request) -> HealthResponse:
        lemmatizer: Lemmatizer | None = getattr(request.app.state, "lemmatizer", None)
        loaded = bool(lemmatizer and lemmatizer.model_loaded)
        return HealthResponse(
            status="ok" if loaded else "starting",
            model_loaded=loaded,
            model_size=(lemmatizer.model_size if lemmatizer else request.app.state.settings.model_size),
        )

    @app.get("/version", response_model=VersionResponse, tags=["meta"])
    async def version(settings: Settings = Depends(_get_settings_dep)) -> VersionResponse:
        return VersionResponse(
            service=settings.service_name,
            service_version=SERVICE_VERSION,
            kiwi_version=_kiwi_version_string(),
            model_size=settings.model_size,
        )

    @app.post(
        "/lemmatize",
        response_model=LemmatizeResponse,
        tags=["analyze"],
        responses={413: {"model": ErrorResponse}, 500: {"model": ErrorResponse}},
    )
    async def lemmatize_endpoint(
        body: LemmatizeRequest,
        settings: Settings = Depends(_get_settings_dep),
        lemmatizer: Lemmatizer = Depends(_get_lemmatizer),
    ) -> LemmatizeResponse:
        _enforce_input_limit(body.text, settings)
        tokens = await run_in_threadpool(lemmatizer.lemmatize, body.text)
        return LemmatizeResponse(tokens=[_to_token_model(t) for t in tokens])

    @app.post(
        "/tokens",
        response_model=TokensResponse,
        tags=["analyze"],
        responses={413: {"model": ErrorResponse}, 500: {"model": ErrorResponse}},
    )
    async def tokens_endpoint(
        body: LemmatizeRequest,
        settings: Settings = Depends(_get_settings_dep),
        lemmatizer: Lemmatizer = Depends(_get_lemmatizer),
    ) -> TokensResponse:
        _enforce_input_limit(body.text, settings)
        triples = await run_in_threadpool(lemmatizer.light_tokens, body.text)
        return TokensResponse(
            tokens=[LightToken(surface=s, lemma=l, pos=p) for (s, l, p) in triples]
        )


def _to_token_model(t: AnalyzedToken) -> Token:
    return Token(surface=t.surface, lemma=t.lemma, pos=t.pos, start=t.start, end=t.end)


# ---------------------------------------------------------------------------
# Error handlers
# ---------------------------------------------------------------------------


def _register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(LemmatizationError)
    async def _lemma_err(_request: Request, exc: LemmatizationError) -> JSONResponse:
        log.error("lemmatize.failed", error=str(exc))
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content=ErrorResponse(
                error="lemmatization_failed",
                detail="Kiwi failed to analyze the input.",
            ).model_dump(),
        )

    @app.exception_handler(HTTPException)
    async def _http_err(_request: Request, exc: HTTPException) -> JSONResponse:
        code = "input_too_long" if exc.status_code == 413 else "http_error"
        return JSONResponse(
            status_code=exc.status_code,
            content=ErrorResponse(error=code, detail=str(exc.detail)).model_dump(),
        )


# ---------------------------------------------------------------------------
# Kiwi version helper (defended against importerror at config time).
# ---------------------------------------------------------------------------


def _kiwi_version_string() -> str:
    # Narrow to ``ImportError`` (the only legitimate failure mode of an
    # ``import kiwipiepy`` call). Any other exception here would be a
    # programming bug that we should NOT mask with "unknown".
    try:
        import kiwipiepy  # type: ignore[import-untyped]
    except ImportError:
        return "unknown"
    return str(getattr(kiwipiepy, "__version__", "unknown"))


# ---------------------------------------------------------------------------
# Module-level app for `uvicorn kiwi_service.app:app` in the Dockerfile CMD.
# ---------------------------------------------------------------------------


app = create_app()
