# 한국어 마스터 (Hangugeo Master)

> Personal Korean learning platform — TOPIK I & II prep, business & fluency focused.

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React + Vite + TypeScript + Tailwind CSS |
| Backend | Node.js + Express + TypeScript |
| Database | Self-hosted PostgreSQL — raw SQL migrations applied by `db/migrate.py` |
| Auth | Custom email/password + TOTP MFA + server-side sessions (no third-party auth provider) |
| Morphology | Kiwi Korean analyzer (internal `kiwi` service) |
| AI | Claude API (Anthropic) — Haiku / Sonnet / Opus 4.x, tiered per task |
| Spaced repetition | FSRS (see `db/docs/ADR-003-fsrs-storage.md`) |

## Local development

The app runs from the repo-root `docker-compose.yml` (client, server on `:4000`,
Postgres, and the Kiwi service):

```bash
# Fill in real values in the service .env files (see each *.env.example)
docker compose up                  # bring up the local stack
python db/migrate.py up            # initialize / migrate the schema
```

Local DB helpers live in `db/scripts/`. Production uses a **separate** blue/green
stack under `Deploy/` — see below.

## Project structure

```
├── client/     # React + Vite frontend (components, pages, services, hooks, types)
├── server/     # Node + Express API (routes, middleware, services incl. Claude + FSRS)
├── services/
│   └── kiwi/   # Korean morphology microservice
├── db/
│   ├── migrations/   # NNN_<name>.up.sql / .down.sql — applied by migrate.py
│   ├── scripts/      # local-dev DB helpers (backup/restore/etc.)
│   └── docs/         # ADRs + design docs
└── Deploy/     # Production blue/green Docker stack (see Deploy/README.md)
```

## Deployment

Production is a **blue/green Docker stack on a self-hosted host** (the project's
own PC), fronted by an nginx load balancer and reached from the internet through
a Cloudflare Tunnel, with **one shared Postgres** behind both colors. Releases
are run by hand on the host (build → deploy to the idle color + migrate +
validate on the test port → flip the load balancer). See **`Deploy/README.md`**
for the full runbook and **`Deploy/SECURITY.md`** for the deploy threat model.

## Status

In active development, well past the initial scaffold. Built so far: TOPIK prep,
vocabulary and grammar SRS, conversation practice, diagnostics, and (in progress)
PDF/ZIP scanned-book uploads. Design decisions and roadmap live in `db/docs/`.
