"""Thin wrapper around `kiwipiepy.Kiwi`.

WHY a wrapper:
- We expose only the two shapes the API needs (full + light), so the rest of
  the codebase isn't coupled to kiwipiepy's `Token` namedtuple-ish object.
- The wrapper is the right seam for tests: we mock at this boundary, not at
  Kiwi's internals.
- It owns the model lifecycle (load once, hold for process lifetime) and
  handles the UTF-16 offset translation Kiwi doesn't give us natively.

Threading: `kiwipiepy.Kiwi.analyze` is internally thread-safe (the underlying
C++ analyzer is reentrant), but we still hold the wrapper as a single instance
on the FastAPI app state. Concurrency comes from uvicorn workers / async
endpoints calling into a sync function via `run_in_threadpool`.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Protocol

import structlog
from kiwipiepy import Kiwi  # type: ignore[import-untyped]

log = structlog.get_logger(__name__)


# ---------------------------------------------------------------------------
# Output types (internal — the API layer translates these to Pydantic models)
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class AnalyzedToken:
    """One morpheme as we return it.

    Offsets are UTF-16 code-unit offsets — JavaScript's `String` is UTF-16,
    so this is what the browser will index with for highlighting. Kiwi gives
    us byte-ish positions; we re-derive UTF-16 here so the client doesn't
    have to.
    """

    surface: str
    lemma: str
    pos: str
    start: int  # UTF-16 code units
    end: int    # exclusive, UTF-16 code units


class _KiwiLike(Protocol):
    """Structural type so tests can substitute a fake Kiwi.

    `analyze(text, top_n=1)` returns a list of `(tokens, score)` pairs;
    each token has `.form`, `.tag`, `.start`, `.len` attributes. We only ever
    look at the top result.
    """

    def analyze(self, text: str, top_n: int = ...) -> list[tuple[list[object], float]]: ...


# ---------------------------------------------------------------------------
# UTF-16 offset translation
# ---------------------------------------------------------------------------


def _build_utf16_offset_table(text: str) -> list[int]:
    """Return a table mapping Python code-point index -> UTF-16 code-unit index.

    Python strings index by code point; JavaScript strings index by UTF-16 code
    unit. Korean syllables (가-힣) are BMP characters (1 unit each), but
    emoji/CJK extensions outside BMP take 2 units (a surrogate pair). We build
    the table once per request so each Kiwi-reported position is O(1) to
    translate.

    table[i] = the UTF-16 unit offset of the i-th Python code point.
    table[len(text)] = the total length in UTF-16 units (so we can slice).
    """
    table = [0] * (len(text) + 1)
    units = 0
    for i, ch in enumerate(text):
        table[i] = units
        # Non-BMP code points (>= U+10000) take a surrogate pair in UTF-16.
        units += 2 if ord(ch) >= 0x10000 else 1
    table[len(text)] = units
    return table


# ---------------------------------------------------------------------------
# The wrapper
# ---------------------------------------------------------------------------


class Lemmatizer:
    """Loads Kiwi once, exposes `lemmatize` and `tokens`.

    Failure modes:
        - Model load failure at construction -> raises RuntimeError. The app
          startup hook catches and refuses to come up; uvicorn exits non-zero
          and Docker/compose restarts.
        - Per-request failure -> logged, re-raised as `LemmatizationError`.
    """

    def __init__(self, model_size: str = "base", *, _engine: _KiwiLike | None = None) -> None:
        """Initialize and warm the model.

        Args:
            model_size: Kiwi model size — `small`, `base`, or `large`.
            _engine: Test seam. If supplied, used instead of constructing Kiwi.
        """
        self._model_size = model_size
        if _engine is not None:
            self._kiwi: _KiwiLike = _engine
            self._loaded = True
            return

        log.info("kiwi.loading", model_size=model_size)
        try:
            # kiwipiepy.Kiwi(model_type='base') as of 0.20+. Older builds use
            # `model_size`; the kwarg name has churned. We pass positional so
            # the binding picks its default → minimal coupling.
            self._kiwi = Kiwi(model_type=model_size)
        except TypeError:
            # Older kiwipiepy: no model_type kwarg. Fall back to default model.
            log.warning("kiwi.model_type_unsupported_falling_back_to_default")
            self._kiwi = Kiwi()
        except Exception as exc:  # noqa: BLE001 — we want the broad catch at boundary
            log.critical("kiwi.load_failed", error=str(exc))
            raise RuntimeError(f"Failed to load Kiwi model ({model_size}): {exc}") from exc
        self._loaded = True
        log.info("kiwi.loaded", model_size=model_size)

    @property
    def model_loaded(self) -> bool:
        return self._loaded

    @property
    def model_size(self) -> str:
        return self._model_size

    # ----- public API -------------------------------------------------------

    def lemmatize(self, text: str) -> list[AnalyzedToken]:
        """Analyze `text` and return tokens with UTF-16 offsets.

        Returns an empty list for empty/whitespace input.
        """
        if not text or not text.strip():
            return []

        try:
            results = self._kiwi.analyze(text, top_n=1)
        except Exception as exc:  # noqa: BLE001
            log.error("kiwi.analyze_failed", error=str(exc), text_len=len(text))
            raise LemmatizationError(str(exc)) from exc

        if not results:
            return []

        tokens_raw, _score = results[0]
        offsets = _build_utf16_offset_table(text)
        out: list[AnalyzedToken] = []
        for tok in tokens_raw:
            # kiwipiepy.Token has: .form, .tag, .start (code-point index),
            # .len (code-point length). We convert to UTF-16 offsets.
            start_cp = int(getattr(tok, "start", 0))
            length_cp = int(getattr(tok, "len", 0))
            end_cp = start_cp + length_cp

            # Clamp to the table — defensive against any future Kiwi reporting quirk.
            start_cp = max(0, min(start_cp, len(text)))
            end_cp = max(start_cp, min(end_cp, len(text)))

            surface = str(getattr(tok, "form", ""))
            tag = str(getattr(tok, "tag", ""))
            # Verbs/adjectives: Kiwi reports the stem (e.g. `만나`) with tag VV.
            # The conventional lemma adds `다`. We do this for VV/VA/VX/VCP/VCN.
            lemma = _stem_to_lemma(surface_from_tag_stem(tok), tag)

            out.append(
                AnalyzedToken(
                    surface=surface,
                    lemma=lemma,
                    pos=tag,
                    start=offsets[start_cp],
                    end=offsets[end_cp],
                )
            )
        return out

    def light_tokens(self, text: str) -> list[tuple[str, str, str]]:
        """Lighter shape: `(surface, lemma, pos)` per token. No offsets."""
        return [(t.surface, t.lemma, t.pos) for t in self.lemmatize(text)]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


# POS tags whose lemma should end in `다` (verbal). Pulled from Kiwi/Sejong tagset:
#   VV  verb           VA  adjective
#   VX  auxiliary verb VCP copula 이다  VCN negative copula 아니다
# Pre-final & final endings (EP/EF/ETM/...) are NOT lemmatized — they're
# functional morphemes, no dictionary form.
_VERBAL_POS: frozenset[str] = frozenset({"VV", "VA", "VX", "VCP", "VCN"})


def surface_from_tag_stem(tok: object) -> str:
    """Extract the morpheme's canonical stem string from a Kiwi Token.

    Kiwi reports `.form` as the stem for verbal POS (already lemma-stem in most
    cases), and as the surface for nominal POS. Either way we just use `.form`
    — the heavy lifting happens in _stem_to_lemma.
    """
    return str(getattr(tok, "form", ""))


def _stem_to_lemma(stem: str, pos: str) -> str:
    """Turn a Kiwi stem + POS into a dictionary-form lemma.

    Examples:
        ("먹", "VV")   -> "먹다"
        ("예쁘", "VA") -> "예쁘다"
        ("친구", "NNG") -> "친구"
        ("이",  "VCP") -> "이다"

    Kiwi already handles the irregular-conjugation normalization on the stem
    itself (so 들어→듣, 더우→덥, 흘러→흐르, 빨가→빨갛, etc.). We just append
    `다` when the POS is verbal.
    """
    if not stem:
        return stem
    if pos in _VERBAL_POS:
        # Some Kiwi versions already include the final 다 for canonical entries.
        return stem if stem.endswith("다") else f"{stem}다"
    return stem


class LemmatizationError(RuntimeError):
    """Raised when Kiwi.analyze fails on a request."""


# ---------------------------------------------------------------------------
# Stdlib logging bridge so kiwipiepy's own logs come out as structlog JSON.
# ---------------------------------------------------------------------------


def configure_stdlib_logging(level: str) -> None:
    """Set the stdlib root logger to the desired level. structlog reads from this."""
    logging.basicConfig(level=level, format="%(message)s")
