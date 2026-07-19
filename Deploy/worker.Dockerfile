# =============================================================================
# km-worker — Track A GPU Whisper transcription worker (tools/audio_stt).
#
# WHY this image exists: the audio transcription worker (tools/audio_stt/
# worker.py) drains the audio_transcription_jobs queue on the shared km-db and
# transcribes tracks with faster-whisper on M's NVIDIA GPU. Like km-loader, it
# runs ON the km-internal network — which is `internal: true` (no egress) — so
# EVERYTHING it needs at runtime must be baked here: Python deps AND the
# Whisper model weights (a runtime Hugging Face download would fail).
#
# BASE IMAGE: nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04. The -cudnn- variant
# is REQUIRED, not a nicety: CTranslate2 (faster-whisper's engine) dynamically
# loads cuDNN for its GPU conv kernels — on a `-base`/`-runtime`-without-cudnn
# image the worker imports fine and then dies at first GPU transcription with
# "Unable to load libcudnn_ops". CUDA 12.4 + cuDNN 9 matches ctranslate2>=4.5's
# build matrix and M's driver (595, RTX 3070).
#
# ffmpeg: faster-whisper decodes input via PyAV. The PyAV wheel bundles its own
# ffmpeg libs, but the corpus includes m4a (Folktales) as well as mp3 — the
# system ffmpeg is installed as a decode backstop and an in-container debugging
# tool (`ffprobe` a blob the worker rejected). Cheap relative to the CUDA base.
#
# MODEL BAKE: the large-v3 weights (~3 GB) are pre-downloaded into the HF cache
# at build time (HF_HOME=/opt/hf-cache) with device='cpu' — the BUILD host may
# have no GPU visible during `docker build`, and model download/cache layout is
# device-independent: the runtime WhisperModel('large-v3', device='cuda')
# resolves the same cached snapshot. This is the km-internal no-egress analog
# of loader.Dockerfile's "bake deps" rule, applied to weights.
#
# SIZE: expect ~7-8 GB total (CUDA+cuDNN runtime base ~3.5 GB, Python deps
# ~0.7 GB, large-v3 weights ~3 GB). Deliberate: this image is built ON M
# (deployment-utils.sh `build_worker`), never CI-built/tar-shipped like
# km-server/km-loader — a multi-GB tar artifact would be impractical, and only
# M has the GPU the image targets. The BUILD needs internet egress (apt, pip,
# Hugging Face); the RUNTIME (km-internal) needs none.
#
# CONFIG: the worker reads its env at startup (tools/audio_stt/config.py):
# DATABASE_URL + AUDIO_UPLOAD_STORAGE_DIR required; AUDIO_STALE_RUN_MINUTES,
# WHISPER_MODEL, WHISPER_DEVICE, WHISPER_COMPUTE_TYPE, POLL_INTERVAL_SEC
# optional. Supplied by docker-compose.shared.yml (km-worker service) or
# deployment-utils.sh `run_worker_once`.
#
# USER: root, matching loader.Dockerfile's posture (single-purpose internal
# tooling image, no listening ports, read-only blob mount at runtime).
#
# BUILD CONTEXT: the REPO ROOT (like loader.Dockerfile), so `COPY tools` works:
#   docker build -t km-worker:latest -f Deploy/worker.Dockerfile .
# =============================================================================
FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    # Stable, image-owned HF cache path — the model bake below writes here and
    # the runtime reads the same snapshot. Never a volume: weights ship in the
    # image because km-internal has no egress to re-download them.
    HF_HOME=/opt/hf-cache \
    HF_HUB_DISABLE_TELEMETRY=1

# python3.11 + -venv from jammy's apt (the base ships no Python). The venv is
# the pip vehicle: Debian/Ubuntu disable `ensurepip` for the system interpreter,
# so a self-contained /opt/venv (same pattern as services/kiwi/Dockerfile) is
# the clean way to get a pip that owns its site-packages.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        python3.11 \
        python3.11-venv \
        ffmpeg \
 && rm -rf /var/lib/apt/lists/* \
 && python3.11 -m venv /opt/venv

# Putting the venv first on PATH makes `python` the venv's python3.11 — for the
# pip layers below, the model bake, and the ENTRYPOINT alike.
ENV PATH="/opt/venv/bin:$PATH"

# Deps, pinned to match loader.Dockerfile where shared (psycopg trio) plus the
# STT stack. ctranslate2 floor 4.5: earlier 4.x links cuDNN 8, which this cuDNN
# 9 base does not provide.
RUN pip install --no-cache-dir \
        "faster-whisper==1.1.1" \
        "ctranslate2>=4.5,<5" \
        "psycopg[binary]==3.2.3" \
        "psycopg-pool>=3.2,<4" \
        "structlog==24.4.0" \
        "requests>=2.31,<3"
# ^ requests is pinned explicitly: faster-whisper's model download goes through
# huggingface_hub, which imports `requests` at download time but (in this
# resolve) does not pull it in transitively — the model BAKE below fails with
# "No module named 'requests'" without it. Pinned so the no-egress runtime is
# never asked to fetch it.

# Bake the large-v3 weights into the image layer (see MODEL BAKE above).
# device='cpu' + int8: the build box has no GPU during `docker build`; the
# download + HF cache layout this produces is exactly what the runtime
# device='cuda' load resolves. Also serves as an import smoke test of the
# whole faster-whisper/ctranslate2 stack at build time.
# NB: the model REVISION is unpinned (faster-whisper exposes no clean way to
# pin the HF revision) — a deliberate, documented deviation from the
# pin-everything rule. The baked layer freezes whatever revision this build
# resolved, so the RUNTIME is still deterministic; only a rebuild can move it.
RUN python -c "from faster_whisper import WhisperModel; WhisperModel('large-v3', device='cpu', compute_type='int8')"

# The weights are baked (above) and the km-internal runtime has NO egress —
# but huggingface_hub's default load path still probes the Hub to check the
# model revision BEFORE falling back to the local cache: on the no-egress
# network that is a ~10s TCP black-hole per worker start, and a hard failure
# if a future hf release tightens the connection-error→cache fallback. Force
# offline mode so the runtime resolves the baked snapshot directly and never
# opens a socket toward the Hub. MUST stay AFTER the bake RUN above — set any
# earlier, it would block the build-time download itself.
ENV HF_HUB_OFFLINE=1

WORKDIR /app

# Worker code only (tools/audio_stt + its tools/ package root — same COPY as
# loader.Dockerfile; gitignored data under tools/ never enters a clean context).
# db/ is NOT copied: migrations run via km-migrate; the worker assumes the
# 073-077 schema is already present on km-db.
COPY tools /app/tools

# The worker is a single long-lived loop with its own SIGTERM/SIGINT handling
# (graceful: settles the in-flight job, then exits) — exec-form so signals
# reach Python as PID 1. Absolute venv interpreter path so the chosen python
# is pinned regardless of any future PATH edits above.
ENTRYPOINT ["/opt/venv/bin/python", "-m", "tools.audio_stt.worker"]
