# km-migrate — deps-only image for running db/migrate.py during a deploy.
#
# WHY this image exists: the migration runner (db/migrate.py) needs psycopg[v3]
# + structlog + Python 3.10+, which the self-hosted deploy agent's host Python
# does not have (and we won't mutate it). It must also run ON the km-internal
# network to reach the shared Postgres (km-db) — but km-internal is declared
# `internal: true` (docker-compose.shared.yml), so a container on it has NO
# internet egress and cannot `pip install` at deploy time. Therefore the deps
# are baked HERE, on the hosted build agent (which has internet), and the image
# is shipped to the server as a tar artifact + `docker load`ed — exactly like
# km-server/km-client/km-kiwi. At deploy time `run_migrate` runs this image with
# ZERO network installs.
#
# This image carries ONLY the deps — no application code. db/migrate.py and the
# migration SQL are bind-mounted read-only from the deployed checkout at run
# time (run_migrate, deployment-utils.sh), so the migration set always matches
# the revision being deployed and this image never needs rebuilding when a new
# migration is added — only when the pinned deps below change.
#
# Deps are pinned for reproducibility; keep them in lockstep with run_migrate's
# historical expectation and db/migrate.py's imports.
FROM python:3.12-slim

# psycopg[binary] ships the libpq wheel so no apt/build-essential is needed.
RUN pip install --no-cache-dir \
        "psycopg[binary]==3.2.3" \
        "structlog==24.4.0"

# No CMD/ENTRYPOINT: run_migrate invokes `python db/migrate.py ...` explicitly
# against the bind-mounted checkout.
