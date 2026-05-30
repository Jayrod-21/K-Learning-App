"""Shared pytest fixtures.

We support two modes:
    1. Real Kiwi present (`kiwipiepy` importable AND its model files present):
       fixtures yield a real `Lemmatizer`. Marked `slow`.
    2. Fake Kiwi: fixtures yield a `Lemmatizer` constructed with a
       hand-rolled fake engine that returns canned analyses for the test
       corpus. Always available; runs in CI without the 100MB model download.

CLI flags:
    --no-slow      skip tests marked `slow` (those that need real Kiwi)
    --require-kiwi fail if real Kiwi isn't available (used in the integration
                   gate, not the fast unit run)
"""

from __future__ import annotations

import importlib
from dataclasses import dataclass

import pytest
from fastapi.testclient import TestClient

from kiwi_service.app import create_app
from kiwi_service.config import Settings
from kiwi_service.lemmatizer import Lemmatizer


# ---------------------------------------------------------------------------
# CLI options
# ---------------------------------------------------------------------------


def pytest_addoption(parser: pytest.Parser) -> None:
    parser.addoption(
        "--no-slow",
        action="store_true",
        default=False,
        help="Skip tests marked `slow` (real Kiwi model).",
    )
    parser.addoption(
        "--require-kiwi",
        action="store_true",
        default=False,
        help="Fail the suite if the real Kiwi model is not loadable.",
    )


def pytest_collection_modifyitems(
    config: pytest.Config, items: list[pytest.Item]
) -> None:
    if config.getoption("--no-slow"):
        skipper = pytest.mark.skip(reason="--no-slow given")
        for item in items:
            if "slow" in item.keywords:
                item.add_marker(skipper)


# ---------------------------------------------------------------------------
# Detect whether the real Kiwi can load. Cheap probe: importable + ctor works.
# We cache the result so we don't pay the load cost twice.
# ---------------------------------------------------------------------------


@dataclass
class KiwiAvailability:
    importable: bool
    loadable: bool
    error: str | None


@pytest.fixture(scope="session")
def kiwi_availability(request: pytest.FixtureRequest) -> KiwiAvailability:
    try:
        importlib.import_module("kiwipiepy")
        importable = True
    except Exception as exc:  # noqa: BLE001
        result = KiwiAvailability(False, False, f"import failed: {exc}")
        if request.config.getoption("--require-kiwi"):
            pytest.fail(f"--require-kiwi but kiwipiepy not importable: {exc}")
        return result

    try:
        Lemmatizer(model_size="base")
        return KiwiAvailability(importable, True, None)
    except Exception as exc:  # noqa: BLE001
        if request.config.getoption("--require-kiwi"):
            pytest.fail(f"--require-kiwi but Kiwi model failed to load: {exc}")
        return KiwiAvailability(importable, False, f"load failed: {exc}")


# ---------------------------------------------------------------------------
# Fake Kiwi engine — canned analyses for known sentences.
# ---------------------------------------------------------------------------


@dataclass
class _FakeToken:
    """Minimal duck of kiwipiepy.Token. Only the attrs Lemmatizer reads."""

    form: str
    tag: str
    start: int
    len: int


# A small canned corpus. Each entry: (text, [(form, tag, start, len), ...]).
# Indexes are Python code-point indexes — that's what the real Kiwi reports.
# Sources: drawn from the TTMIK/Iyagi JSONs and DESIGN_SPEC examples.
_CANNED: dict[str, list[tuple[str, str, int, int]]] = {
    # Spec example
    "어제 친구를 만났어요": [
        ("어제", "MAG", 0, 2),
        ("친구", "NNG", 3, 2),
        ("를", "JKO", 5, 1),
        ("만나", "VV", 7, 2),     # 만났 -> stem 만나 (ㅏ contraction)
        ("었", "EP", 8, 1),
        ("어요", "EF", 9, 2),
    ],
    # ㅂ-irregular: 더우 -> 덥다
    "날씨가 더워요": [
        ("날씨", "NNG", 0, 2),
        ("가", "JKS", 2, 1),
        ("덥", "VA", 4, 1),       # ㅂ-irreg normalized to stem 덥
        ("어요", "EF", 5, 2),
    ],
    # ㄷ-irregular: 들어 -> 듣다
    "음악을 들어요": [
        ("음악", "NNG", 0, 2),
        ("을", "JKO", 2, 1),
        ("듣", "VV", 4, 1),       # ㄷ-irreg normalized
        ("어요", "EF", 5, 2),
    ],
    # 르-irregular: 흘러 -> 흐르다
    "물이 흘러요": [
        ("물", "NNG", 0, 1),
        ("이", "JKS", 1, 1),
        ("흐르", "VV", 3, 2),
        ("어요", "EF", 5, 2),
    ],
    # ㅎ-irregular: 빨가 -> 빨갛다
    "빨간 사과": [
        ("빨갛", "VA", 0, 2),     # 빨간 -> 빨갛 stem
        ("ㄴ", "ETM", 1, 1),
        ("사과", "NNG", 3, 2),
    ],
    # ㅅ-irregular: 지어 -> 짓다
    "집을 지어요": [
        ("집", "NNG", 0, 1),
        ("을", "JKO", 1, 1),
        ("짓", "VV", 3, 1),
        ("어요", "EF", 4, 2),
    ],
    # ㅡ-irregular: 써 -> 쓰다
    "편지를 써요": [
        ("편지", "NNG", 0, 2),
        ("를", "JKO", 2, 1),
        ("쓰", "VV", 4, 1),
        ("어요", "EF", 5, 2),
    ],
    # ㄹ-irregular: 만드 -> 만들다 (ㄹ drops before -ㅂ/-ㄴ/-ㅅ/-(으))
    "케이크를 만들어요": [
        ("케이크", "NNG", 0, 3),
        ("를", "JKO", 3, 1),
        ("만들", "VV", 5, 2),
        ("어요", "EF", 7, 2),
    ],
    # Heavy agglutination: 먹었었어요 -> 먹다 + 었었어요
    "먹었었어요": [
        ("먹", "VV", 0, 1),
        ("었", "EP", 1, 1),
        ("었", "EP", 2, 1),
        ("어요", "EF", 3, 2),
    ],
    # Real Iyagi sentence
    "안녕하세요": [
        ("안녕하", "VA", 0, 3),
        ("세요", "EF", 3, 2),
    ],
}


class _FakeKiwi:
    """Implements `analyze(text, top_n=...)` for canned inputs.

    For unknown text: returns a single 'unknown' NNG token spanning the input
    so the wrapper still has something to translate. Tests should stick to
    canned strings.
    """

    def analyze(self, text: str, top_n: int = 1) -> list[tuple[list[_FakeToken], float]]:
        canned = _CANNED.get(text)
        if canned is None:
            # Defensive: return one token spanning the input.
            return [
                ([_FakeToken(form=text, tag="NNG", start=0, len=len(text))], 0.0),
            ]
        tokens = [_FakeToken(form=f, tag=t, start=s, len=length) for (f, t, s, length) in canned]
        return [(tokens, 1.0)]


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def fake_engine() -> _FakeKiwi:
    return _FakeKiwi()


@pytest.fixture
def fake_lemmatizer(fake_engine: _FakeKiwi) -> Lemmatizer:
    """Lemmatizer wired to the fake engine. Fast, no model download."""
    return Lemmatizer(model_size="base", _engine=fake_engine)


@pytest.fixture
def real_lemmatizer(kiwi_availability: KiwiAvailability) -> Lemmatizer:
    """Real Kiwi. Skips if not available."""
    if not kiwi_availability.loadable:
        pytest.skip(f"Real Kiwi not available: {kiwi_availability.error}")
    return Lemmatizer(model_size="base")


@pytest.fixture
def test_settings() -> Settings:
    """Settings with a tight max_input_chars so we can exercise the 413 path."""
    return Settings(max_input_chars=32, log_level="WARNING")  # type: ignore[call-arg]


@pytest.fixture
def client_no_lifespan(fake_lemmatizer: Lemmatizer, test_settings: Settings) -> TestClient:
    """TestClient that never enters lifespan startup.

    Why: lifespan loads the real Kiwi model, which is slow and may not be
    available in CI. We construct the app via the factory, then plant the
    fake lemmatizer + settings directly on `app.state` so the route
    dependencies pick them up. We instantiate `TestClient(app)` WITHOUT
    using it as a context manager — that skips lifespan entirely.
    """
    app = create_app(settings=test_settings)
    app.state.settings = test_settings
    app.state.lemmatizer = fake_lemmatizer
    return TestClient(app)
