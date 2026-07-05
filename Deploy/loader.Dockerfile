# km-loader — corpus + KRDICT loaders, baked with their deps and code.
#
# WHY this image exists: the corpus loaders (tools/ingest) and the KRDICT loader
# need Python 3.12 + psycopg/psycopg-pool/pydantic/structlog/defusedxml, and they
# must run ON the km-internal network to reach the shared Postgres (km-db) — which
# is `internal: true` (no egress), so a container there cannot pip-install. As
# with km-migrate, deps are baked HERE on the hosted build agent and the image is
# shipped to the server as a tar artifact + `docker load`ed.
#
# DIFFERENT from km-migrate in ONE way: this image also BAKES the loader CODE
# (tools/). The deploy checkout is wiped each run and the loaders are run as a
# MANUAL operator step (the corpus JSON / KRDICT XML are gitignored and arrive on
# the server by USB, not via git), so we don't want the run to depend on a live
# checkout. Code in the image, DATA on a bind mount (run_loader, load-corpora.sh,
# load-krdict.sh). The image is rebuilt each release (tagged $(deployTag)); it
# only needs rebuilding when the deps or loader code change.
#
# NOTE on the build context: this Dockerfile is built with the REPO ROOT as the
# context (azure-pipelines.yml) so `COPY tools` works. The corpus JSON under
# tools/ingest/output/ and the _work/ scratch are gitignored, so the CI checkout
# (tracked files only) does not carry them into the context — the image stays
# lean and never ships data.
FROM python:3.12-slim

# psycopg[binary] ships the libpq wheel (no apt/build-essential). psycopg-pool is
# used by the corpus loader runtime; pydantic + defusedxml by the KRDICT path;
# pypdf (pure-python — no poppler/apt needed) by the ttmik_transcript loader,
# which reads the Lesson Scripts PDFs straight from the corpus mount.
RUN pip install --no-cache-dir \
        "psycopg[binary]==3.2.3" \
        "psycopg-pool>=3.2,<4" \
        "structlog==24.4.0" \
        "pydantic>=2,<3" \
        "defusedxml>=0.7,<0.8" \
        "pypdf>=5,<6"

WORKDIR /app

# Loader code only. db/ is NOT copied — migrations run via km-migrate; the
# loaders assume the schema is already present on km-db.
COPY tools /app/tools

# No CMD/ENTRYPOINT: run_loader (deployment-utils.sh) invokes the specific loader
# module explicitly, with the host data dir bind-mounted at /data.
