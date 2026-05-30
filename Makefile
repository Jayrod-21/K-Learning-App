# =============================================================================
# Korean Master — developer ergonomics
# =============================================================================
# This Makefile is the SOLE interface a developer needs. If you find yourself
# typing a raw `docker compose` or `psql` invocation, that's a bug — add a
# target.
#
# Conventions:
#   - All db.* targets read db/.env if present, then Repository/.env.
#   - Destructive targets (db-reset, db-rollback) require an explicit CONFIRM.
#   - Targets are dependency-free where possible so you can run them in any
#     order without having to remember setup steps.
# =============================================================================

SHELL := /usr/bin/env bash
.SHELLFLAGS := -euo pipefail -c
.DEFAULT_GOAL := help

# ---------------------------------------------------------------------------
# Env loading — db/.env wins over root .env for db-targeted variables.
# ---------------------------------------------------------------------------
ifneq (,$(wildcard ./.env))
include .env
export
endif
ifneq (,$(wildcard ./db/.env))
include ./db/.env
export
endif

COMPOSE         ?= docker compose
PYTHON          ?= python3
DB_SERVICE      ?= db
DB_CONTAINER    ?= korean-master-db
POSTGRES_USER   ?= korean_master
POSTGRES_DB     ?= korean_master
BACKUP_DIR      ?= ./db/backups
HEALTH_WAIT_SEC ?= 120
TIMESTAMP       := $(shell date -u +%Y%m%dT%H%M%SZ)

# Wait helper — polls `docker inspect` until the container reports healthy.
# N4 (REVIEW_A3): use `docker inspect --format '{{.State.Health.Status}}'`
# instead of parsing `docker compose ps --format json` (whose shape has
# churned across compose v2.x and is fragile to feed through a Python one-
# liner). N7: 60 s was too short on cold initdb — bumped to 120 s, overridable
# via HEALTH_WAIT_SEC.
define WAIT_HEALTHY
	@echo ">> waiting for $(DB_CONTAINER) to become healthy (max $(HEALTH_WAIT_SEC)s)"
	@for i in $$(seq 1 $(HEALTH_WAIT_SEC)); do \
	  status=$$(docker inspect --format '{{.State.Health.Status}}' $(DB_CONTAINER) 2>/dev/null || true); \
	  if [ "$$status" = "healthy" ]; then echo ">> healthy"; exit 0; fi; \
	  sleep 1; \
	done; \
	echo "!! $(DB_CONTAINER) did not become healthy in $(HEALTH_WAIT_SEC)s"; exit 1
endef

# ---------------------------------------------------------------------------
.PHONY: help
help: ## Show this help.
	@awk 'BEGIN {FS = ":.*##"; printf "Targets:\n"} \
	  /^[a-zA-Z0-9_-]+:.*?##/ { printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2 }' \
	  $(MAKEFILE_LIST)

# ===========================================================================
# Database lifecycle
# ===========================================================================

.PHONY: db-up
db-up: ## Start the Postgres container, wait until healthy.
	$(COMPOSE) up -d $(DB_SERVICE)
	$(WAIT_HEALTHY)

.PHONY: db-down
db-down: ## Stop the Postgres container (volume preserved).
	$(COMPOSE) stop $(DB_SERVICE)

.PHONY: db-reset
db-reset: ## DESTRUCTIVE — drop the db volume and restart. Requires CONFIRM=YES.
	@if [ "$(CONFIRM)" != "YES" ]; then \
	  echo "Refusing to reset. Re-run as: make db-reset CONFIRM=YES"; exit 1; \
	fi
	# SF3 in REVIEW_A3: `docker compose down -v <SERVICE>` removes ALL named
	# project volumes (the trailing SERVICE arg is ignored for `-v`).
	# Stop+rm the db service explicitly, then drop ONLY its named volume.
	$(COMPOSE) stop $(DB_SERVICE) || true
	$(COMPOSE) rm -f $(DB_SERVICE) || true
	docker volume rm korean_master_db_data 2>/dev/null || true
	$(COMPOSE) up -d $(DB_SERVICE)
	$(WAIT_HEALTHY)

# ===========================================================================
# Migrations
# ===========================================================================

.PHONY: db-migrate
db-migrate: ## Apply all pending up migrations.
	$(PYTHON) db/migrate.py up $(EXTRA_FLAGS)

.PHONY: db-migrate-status
db-migrate-status: ## Show which migrations have been applied.
	$(PYTHON) db/migrate.py status

.PHONY: db-rollback
db-rollback: ## Roll back the most recent migration. Requires CONFIRM=YES.
	@if [ "$(CONFIRM)" != "YES" ]; then \
	  echo "Refusing to roll back. Re-run as: make db-rollback CONFIRM=YES"; exit 1; \
	fi
	$(PYTHON) db/migrate.py --allow-destructive down $(EXTRA_FLAGS)

.PHONY: db-migrate-dry-run
db-migrate-dry-run: ## Print what `db-migrate` would do.
	$(PYTHON) db/migrate.py --dry-run up

# ===========================================================================
# Backup / restore
# ===========================================================================

.PHONY: db-backup
db-backup: ## pg_dump to a timestamped file under BACKUP_DIR.
	@mkdir -p "$(BACKUP_DIR)" && chmod 0700 "$(BACKUP_DIR)"
	BACKUP_DIR="$(BACKUP_DIR)" \
	POSTGRES_USER="$(POSTGRES_USER)" \
	POSTGRES_DB="$(POSTGRES_DB)" \
	  bash db/scripts/backup.sh

.PHONY: db-restore
db-restore: ## Restore from FILE=... (a pg_dump custom-format file).
	@if [ -z "$(FILE)" ]; then echo "Usage: make db-restore FILE=path/to/dump"; exit 1; fi
	@if [ "$(CONFIRM)" != "YES" ]; then \
	  echo "Restore overwrites the current DB. Re-run as: make db-restore FILE=$(FILE) CONFIRM=YES"; \
	  exit 1; \
	fi
	POSTGRES_USER="$(POSTGRES_USER)" \
	POSTGRES_DB="$(POSTGRES_DB)" \
	BACKUP_DIR="$(BACKUP_DIR)" \
	  bash db/scripts/restore.sh "$(FILE)"

# ===========================================================================
# Testing & dev tooling
# ===========================================================================

.PHONY: db-test
db-test: ## Run integration tests (up cycle + down cycle).
	$(PYTHON) -m pytest db/tests -v

.PHONY: db-shell
db-shell: ## Open psql against the running container.
	# SF6 in REVIEW_A3: force -it so CI / IDE terminals that lie about
	# isatty() get a proper interactive session (and an honest failure if
	# stdin really isn't a tty).
	$(COMPOSE) exec -it $(DB_SERVICE) psql -U $(POSTGRES_USER) -d $(POSTGRES_DB)

.PHONY: db-lint
db-lint: ## Lint migration SQL with sqlfluff (Postgres dialect).
	$(PYTHON) -m sqlfluff lint --dialect postgres db/migrations
