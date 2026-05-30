# =============================================================================
# Kiwi Morphological Analyzer Service — multi-stage build
# =============================================================================
# Stage 1 (`builder`): install build deps, build a wheel/venv.
# Stage 2 (`runtime`): copy only the venv + source. Slim final image.
#
# Why multi-stage: kiwipiepy's wheel is binary (manylinux) and ships the Kiwi
# model files. We don't need apt build tools, pip caches, or test deps in the
# final image. This drops ~200MB off the runtime layer.
# =============================================================================

ARG PYTHON_VERSION=3.12

# ----- builder ---------------------------------------------------------------
FROM python:${PYTHON_VERSION}-slim-bookworm AS builder

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# Build deps. We keep them in the builder only.
# `build-essential` is needed if pip falls back to building from sdist
# (kiwipiepy ships manylinux wheels for cpython 3.12, so this is a backstop).
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Copy only the metadata first so pip layer caches across source changes.
COPY pyproject.toml /build/pyproject.toml
COPY src /build/src

# Create a self-contained venv we can copy to the runtime image.
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Install runtime deps + the package itself. No dev extras in the image.
RUN pip install --upgrade pip setuptools wheel \
 && pip install .

# ----- runtime ---------------------------------------------------------------
FROM python:${PYTHON_VERSION}-slim-bookworm AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:$PATH" \
    # `kiwi` user is created with --no-create-home so the only writable
    # path in the read-only-rootfs deployment is the /tmp tmpfs. Point HOME
    # there so any library (kiwipiepy, urllib, pip's user-site fallback)
    # that resolves ~/.cache lands on the tmpfs instead of crashing on a
    # read-only root. SECURITY.md hardening checklist documents this.
    # See REVIEW_B1.md F-3.
    HOME=/tmp \
    XDG_CACHE_HOME=/tmp/.cache \
    # Default config — override via env.
    KIWI_HOST=0.0.0.0 \
    KIWI_PORT=8000 \
    KIWI_LOG_LEVEL=INFO \
    KIWI_MODEL_SIZE=base \
    KIWI_MAX_INPUT_CHARS=4096

# Curl is needed for the HEALTHCHECK below. tini gives us PID 1 with proper
# signal forwarding (Kiwi's underlying C++ analyzer responds to SIGTERM via
# Python, but tini makes shutdown deterministic).
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl tini \
 && rm -rf /var/lib/apt/lists/* \
 && apt-get clean

# Non-root user — defense in depth. The service has no need to write anywhere
# except its own venv, which is read-only at runtime.
RUN groupadd --system --gid 1000 kiwi \
 && useradd --system --uid 1000 --gid kiwi --no-create-home --shell /usr/sbin/nologin kiwi

# Bring over the venv + source from the builder.
COPY --from=builder /opt/venv /opt/venv
COPY --from=builder /build/src /app/src

WORKDIR /app
ENV PYTHONPATH=/app/src

USER kiwi

EXPOSE 8000

# Healthcheck pings /health. We accept `status: starting` for the first 60s
# (model load) by setting a generous start_period; after that, only `ok` is OK.
HEALTHCHECK --interval=15s --timeout=3s --start-period=60s --retries=3 \
  CMD python -c "import json,sys,urllib.request,os; r=urllib.request.urlopen('http://127.0.0.1:'+os.environ['KIWI_PORT']+'/health',timeout=2).read(); sys.exit(0 if json.loads(r).get('model_loaded') is True else 1)" \
      || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]

# uvicorn with one worker — Kiwi holds the model in memory and the workload
# is CPU-bound; multiple workers multiply memory without improving throughput
# meaningfully for our scale (single user). Scale horizontally if needed.
CMD ["sh", "-c", "exec uvicorn kiwi_service.app:app --host ${KIWI_HOST} --port ${KIWI_PORT} --log-config /dev/null"]
