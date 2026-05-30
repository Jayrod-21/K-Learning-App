"""Service configuration via Pydantic BaseSettings.

12-factor: every knob is an env var with a typed default. No hardcoded values
in app code; reading env directly in modules is a smell — they import this.

Env var prefix: KIWI_  (e.g. KIWI_PORT, KIWI_LOG_LEVEL, KIWI_MAX_INPUT_CHARS).
"""

from __future__ import annotations

from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


# Kiwi ships several model sizes. `small` is ~30MB, `base` ~100MB, `large` ~400MB.
# For our use case (tap-a-word on intermediate-to-advanced Korean) `base` is the
# right default: notably better on irregular conjugations than `small`, far
# smaller and faster to load than `large`. See ADR-014 §model-size.
KiwiModelSize = Literal["small", "base", "large"]
LogLevel = Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]


class Settings(BaseSettings):
    """Service settings. Read once at process start.

    All fields are immutable after construction (`frozen=True`) — config changes
    require a restart, which matches the 12-factor model.
    """

    model_config = SettingsConfigDict(
        env_prefix="KIWI_",
        env_file=".env",
        env_file_encoding="utf-8",
        # ``extra="ignore"`` (not the project's usual ``forbid``) because env
        # namespaces routinely include unrelated ``KIWI_*`` vars from the
        # operator's shell or compose templates — refusing to start on a
        # stray ``KIWI_HELPER=…`` would be hostile. We log unknown env keys
        # at INFO at startup so they're still visible. See REVIEW_B1.md F-11.
        extra="ignore",
        frozen=True,
        # protected_namespaces=() because ``model_size`` collides with
        # Pydantic v2's reserved ``model_*`` prefix. The field name is the
        # B3-facing contract — renaming would ripple through every consumer.
        # See REVIEW_B1.md F-1.
        protected_namespaces=(),
    )

    # --- HTTP -----------------------------------------------------------------
    host: str = Field(default="0.0.0.0", description="Bind address. 0.0.0.0 inside container; the compose network is internal-only.")  # noqa: S104
    port: int = Field(default=8000, ge=1, le=65535)

    # --- Model ----------------------------------------------------------------
    model_size: KiwiModelSize = Field(default="base")

    # --- Limits / DoS defenses -----------------------------------------------
    # Hard cap on a single request body. Kiwi is O(n) but pathological strings
    # (massive single token, huge alternation) can still spike CPU. 4 KB is
    # enough for any TOPIK passage we'd lemmatize in one call — clients should
    # chunk by sentence.
    max_input_chars: int = Field(default=4096, ge=16, le=65536)

    # Per-request wall-clock budget. The Express gateway times out faster
    # (typically 2-3s); this is a backstop.
    request_timeout_seconds: float = Field(default=5.0, gt=0, le=60)

    # --- Observability --------------------------------------------------------
    log_level: LogLevel = Field(default="INFO")
    service_name: str = Field(default="kiwi-service")

    @field_validator("model_size", mode="before")
    @classmethod
    def _lower_model_size(cls, v: object) -> object:
        """Accept `BASE` / `Base` from env without forcing exact case."""
        if isinstance(v, str):
            return v.lower()
        return v


def get_settings() -> Settings:
    """Build a Settings instance. Separate function so tests can monkeypatch.

    Not memoized at module level — that hides config changes during pytest runs.
    The FastAPI app caches via Depends() instead (see app.py).
    """
    return Settings()
