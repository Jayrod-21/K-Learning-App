# Live-State Verification Audit — Korean Master (062/063/064 + deploy b2b-477e708)

**Auditor:** Independent live-state verification (read-only). **Date:** 2026-07-15.
**Host:** M. **DB container:** `km-db` (Postgres 16, database `korean_master`, user `korean_master`).
**Active environment:** `green` (per `Deploy/.env` `ACTIVE_ENVIRONMENT=green`).

All queries were read-only (SELECT / catalog inspection). No DB mutation, no deploy, no git state change. Secrets redacted.

## Results

| # | Check | Verdict | Evidence (actual output) |
|---|-------|---------|--------------------------|
| 1 | Migrations 062/063/064 recorded in `schema_migrations` | **VERIFIED** | `SELECT version ... IN ('062','063','064')` → returns `062`, `063`, `064` (3 rows). Max applied version = **064**, total 64 migrations. Names: 062=`revoke_km_app_temp`, 063=`notification_deliveries_claim_key`, 064=`backfill_notification_schedules_from_prefs`; all `applied_at` 2026-07-15 20:35:05 UTC. |
| 2 | F-089 (062): `km_app` no longer has DB TEMP (and PUBLIC) | **VERIFIED** | `has_database_privilege('km_app','korean_master','TEMP')` = **f**; `has_database_privilege('public','korean_master','TEMP')` = **f**. `km_app` CONNECT still = t (expected — only TEMP revoked). |
| 3 | F-092 (063): `notification_deliveries.window_start` NOT NULL + UNIQUE(schedule_id, window_start) | **VERIFIED** | `information_schema.columns`: `window_start` `is_nullable=NO`, type `timestamp with time zone`. Unique index `uq_notification_deliveries_schedule_window` on `(schedule_id, window_start)` present; matching UNIQUE constraint `uq_notification_deliveries_schedule_window UNIQUE (schedule_id, window_start)` present in `pg_constraint`. |
| 4 | F-093 (064): backfill migration applied + `notification_schedules` table sane | **VERIFIED** | Migration 064 recorded (see #1). `notification_schedules` exists with 11 columns (id, user_id, kind, channel, time_of_day, tz, weekday, enabled, created_at, updated_at, version) — shape sane. Row count = **3** (data-dependent backfill; non-empty). |
| 5 | Deploy reality: active green containers Up+healthy on `b2b-477e708`, km-lb serving, /health 200 | **VERIFIED** | `docker ps`: `km-server-green` `km-client-green` `km-kiwi-green` all **Up ~2 min (healthy)** on image `:b2b-477e708`. `docker inspect km-server-green` → `km-server:b2b-477e708` created 2026-07-15T21:09:08Z. Health status green server/client/lb all `healthy`. `curl https://korean.jaredstudio.com/health` → **200**. (Idle blue color runs older `b2a-03816b3` — expected for rollback.) |
| 6 | Pre-migration backup exists (~2026-07-15T20:35Z, ~30M) | **VERIFIED** | `~/KoreanMaster/backups/km-20260715T203500Z.dump` — **30,731,903 bytes (~30M)**, mtime Jul 15 14:35 local (= 20:35:00 UTC). Timestamp precedes migration `applied_at` 20:35:05 UTC by 5s → genuine pre-migration snapshot. `.dump.info` sidecar present. |

## Summary

**6 / 6 VERIFIED. No discrepancies.**

- `schema_migrations` max version = **064**; 062/063/064 all present, applied 2026-07-15 20:35:05 UTC.
- `km_app` DB-level **TEMP is revoked** (and PUBLIC TEMP revoked); CONNECT retained.
- 063 **UNIQUE(schedule_id, window_start) constraint + index exist**; `window_start` is NOT NULL.
- Production active color **green** runs image tag **`b2b-477e708`** (the expected tag), all containers healthy, km-lb serving, `/health` = 200.
- Pre-migration backup `km-20260715T203500Z.dump` (~30M) confirmed on disk, timestamped immediately before the migration run.
