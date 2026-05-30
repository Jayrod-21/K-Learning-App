"""HTTP-level tests for the FastAPI app.

We use the fake Kiwi via the `client_no_lifespan` fixture so the suite runs
in <1s without downloading the Kiwi model. The `slow` integration test at the
bottom exercises the lifespan path against real Kiwi.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from kiwi_service.app import create_app
from kiwi_service.config import Settings


class TestHealth:
    def test_ok_when_model_loaded(self, client_no_lifespan: TestClient) -> None:
        r = client_no_lifespan.get("/health")
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "ok"
        assert body["model_loaded"] is True
        assert body["model_size"] == "base"

    def test_starting_when_model_missing(self) -> None:
        # Build an app with NO lemmatizer on state — simulates pre-startup.
        # We intentionally do NOT use the TestClient context manager (which
        # would run lifespan and load real Kiwi).
        settings = Settings(max_input_chars=64, log_level="WARNING")  # type: ignore[call-arg]
        app = create_app(settings=settings)
        # No lemmatizer planted; health should report `starting`.
        client = TestClient(app)
        r = client.get("/health")
        assert r.status_code == 200
        body = r.json()
        assert set(body.keys()) == {"status", "model_loaded", "model_size"}
        assert body["status"] == "starting"
        assert body["model_loaded"] is False


class TestVersion:
    def test_returns_service_and_kiwi_versions(self, client_no_lifespan: TestClient) -> None:
        r = client_no_lifespan.get("/version")
        assert r.status_code == 200
        body = r.json()
        assert body["service"] == "kiwi-service"
        assert body["service_version"]
        assert "kiwi_version" in body
        assert body["model_size"] == "base"


class TestLemmatize:
    def test_happy_path(self, client_no_lifespan: TestClient) -> None:
        r = client_no_lifespan.post("/lemmatize", json={"text": "어제 친구를 만났어요"})
        assert r.status_code == 200, r.text
        body = r.json()
        assert "tokens" in body
        surfaces = [t["surface"] for t in body["tokens"]]
        assert surfaces == ["어제", "친구", "를", "만나", "었", "어요"]
        # Offsets present and ordered
        for t in body["tokens"]:
            assert {"surface", "lemma", "pos", "start", "end"} <= set(t.keys())
            assert t["end"] >= t["start"]

    def test_empty_text_400(self, client_no_lifespan: TestClient) -> None:
        # Pydantic rejects min_length=1 violation -> 422.
        r = client_no_lifespan.post("/lemmatize", json={"text": ""})
        assert r.status_code == 422

    def test_missing_field_422(self, client_no_lifespan: TestClient) -> None:
        r = client_no_lifespan.post("/lemmatize", json={})
        assert r.status_code == 422

    def test_extra_field_rejected(self, client_no_lifespan: TestClient) -> None:
        # `extra="forbid"` on LemmatizeRequest.
        r = client_no_lifespan.post(
            "/lemmatize", json={"text": "안녕하세요", "rogue": "x"}
        )
        assert r.status_code == 422

    def test_oversize_413(self, client_no_lifespan: TestClient) -> None:
        # test_settings caps max_input_chars at 32.
        long_text = "안" * 33
        r = client_no_lifespan.post("/lemmatize", json={"text": long_text})
        assert r.status_code == 413
        body = r.json()
        assert body["error"] == "input_too_long"

    def test_request_id_echoed(self, client_no_lifespan: TestClient) -> None:
        r = client_no_lifespan.post(
            "/lemmatize",
            json={"text": "어제 친구를 만났어요"},
            headers={"x-request-id": "test-req-123"},
        )
        # The middleware echoes the header back on the response.
        assert r.headers.get("x-request-id") == "test-req-123"

    def test_request_id_generated_when_absent(self, client_no_lifespan: TestClient) -> None:
        r = client_no_lifespan.post("/lemmatize", json={"text": "어제 친구를 만났어요"})
        assert r.headers.get("x-request-id"), "request id should be minted"


class TestTokens:
    def test_returns_light_shape_without_offsets(
        self, client_no_lifespan: TestClient
    ) -> None:
        r = client_no_lifespan.post("/tokens", json={"text": "어제 친구를 만났어요"})
        assert r.status_code == 200
        body = r.json()
        assert "tokens" in body
        assert body["tokens"]
        for t in body["tokens"]:
            assert set(t.keys()) == {"surface", "lemma", "pos"}

    def test_same_input_limit_as_lemmatize(self, client_no_lifespan: TestClient) -> None:
        r = client_no_lifespan.post("/tokens", json={"text": "안" * 33})
        assert r.status_code == 413


class TestErrorContract:
    def test_413_body_has_error_and_detail(self, client_no_lifespan: TestClient) -> None:
        r = client_no_lifespan.post("/lemmatize", json={"text": "안" * 100})
        body = r.json()
        assert set(body.keys()) == {"error", "detail"}
        assert "KIWI_MAX_INPUT_CHARS" in body["detail"]


# ---------------------------------------------------------------------------
# Integration test against real Kiwi via full lifespan.
# ---------------------------------------------------------------------------


@pytest.mark.slow
class TestRealLifespan:
    def test_real_model_loads_via_lifespan(self, kiwi_availability) -> None:
        if not kiwi_availability.loadable:
            pytest.skip(f"Real Kiwi not available: {kiwi_availability.error}")
        settings = Settings(model_size="base", log_level="WARNING")  # type: ignore[call-arg]
        app = create_app(settings=settings)
        with TestClient(app) as client:
            r = client.get("/health")
            assert r.json()["model_loaded"] is True
            r = client.post("/lemmatize", json={"text": "어제 친구를 만났어요"})
            assert r.status_code == 200
            lemmas = {t["lemma"] for t in r.json()["tokens"]}
            assert "만나다" in lemmas
