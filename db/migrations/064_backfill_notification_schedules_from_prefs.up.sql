-- migrate: non-destructive
-- =============================================================================
-- Migration 064 — backfill notification_schedules from the 018 prefs blob
--   (F-093 expand step)
--   UP — one-time data backfill: for every user whose `users.preferences`
--        (018) `notif` blob already expresses an enabled EMAIL-channel intent
--        (daily / reviewsDue / weekly booleans, gated on `channel.email`),
--        INSERT an equivalent enabled `notification_schedules` (052) row —
--        ONLY if that (user, kind, 'email') row does not already exist. This
--        is the "expand" half of F-093's expand-contract: it makes
--        `notification_schedules` hold every user's PRE-existing notif intent
--        so the canonical table is never missing data the old Settings
--        screen had already recorded, before any code stops reading the blob.
--   Reverse: 064_backfill_notification_schedules_from_prefs.down.sql (DELETE
--        — declared destructive; see its own header for the exact scoping
--        that keeps it from touching a real post-backfill user edit).
--   Depends on: 018_user_preferences (users.preferences),
--               052_notification_schedules (notification_schedules).
--
-- MAPPING (mirrors client/src/pages/Settings.tsx's pre-F-040 SCHEDULE_DEFAULTS
-- and the F-040 client's hardcoded email-only channel):
--   blob key                  -> schedule kind       default time  weekday
--   notif.daily                  daily_reminder        08:00        NULL
--   notif.reviewsDue              reviews_due           18:00        NULL
--   notif.weekly                  weekly_report         09:00        0 (Sun)
-- `tz` backfills to 'UTC' — the boolean-only blob never recorded a timezone,
-- so there is nothing truer to derive; the user's next real Settings visit
-- corrects it via a normal PUT /notifications/schedules once F-093's client
-- lands, exactly like any other suggested-default the client seeds today.
--
-- WHY GATE ON channel.email: the blob's booleans have no notion of "which
-- channel" — `channel.email`/`channel.sms` were the only channel toggles, and
-- the F-040 client only ever creates 'email' schedule rows (sms has no send
-- infrastructure — F-040's placeholder). Backfilling into 'push' or 'sms'
-- would invent a channel the user never actually saw an ON toggle for; email
-- is the one channel with real send behavior planned, and the blob's OWN
-- `channel.email` boolean is the closest signal to "did they want an email".
-- A user with channel.email=false backfills NOTHING (matches F-040's "nothing
-- is implicitly on" model — abstaining is the same as never having a row).
--
-- WHY ON CONFLICT DO NOTHING: any user who has ALREADY interacted with
-- /notifications/schedules (even just once, on any kind/channel) keeps their
-- own row untouched — real user data (however it was set) always wins over a
-- backfill guess. Only kinds with NO existing (user, kind, 'email') row adopt
-- the blob-derived backfill.
--
-- WHY DEFENSIVE jsonb_typeof GUARDS: `users.preferences` is a JSONB column
-- with NO shape enforced at the database layer (PrefsSchema validates only at
-- the route) — migration 018's own default is an empty `{}`, and any
-- hand-edited or ancient blob could carry a non-boolean value at these paths.
-- Casting straight to `::boolean` would ABORT THE WHOLE MIGRATION (and thus
-- the deploy) on one user's malformed blob. `jsonb_typeof(...) = 'boolean'`
-- gates the cast so anything else (missing key, object, array, string,
-- number, null) is treated as "no confirmed intent" (false) — the same
-- conservative direction PrefsSchema's own GET-side safeParse falls back to
-- (DEFAULT_PREFS) rather than guessing a user's intent from garbage.
--
-- MARKER (F-088): declared non-destructive — this is a pure INSERT (with
-- ON CONFLICT DO NOTHING) into a table nothing else has populated for these
-- users yet; no existing row is read, altered, or removed.
--
-- TRANSACTION OWNERSHIP (ADR-013): no top-level BEGIN/COMMIT — migrate.py
-- wraps this body in a single transaction together with the bookkeeping
-- write.
-- =============================================================================

INSERT INTO notification_schedules
        (user_id, kind, channel, time_of_day, tz, weekday, enabled)
SELECT
    u.id,
    v.kind,
    'email',
    v.time_of_day::time,
    'UTC',
    v.weekday,
    true
FROM users u
CROSS JOIN LATERAL (
    VALUES
        ('daily_reminder', '08:00'::text, NULL::smallint, ARRAY['notif','daily']::text[]),
        ('reviews_due',    '18:00'::text, NULL::smallint, ARRAY['notif','reviewsDue']::text[]),
        ('weekly_report',  '09:00'::text, 0::smallint,    ARRAY['notif','weekly']::text[])
) AS v(kind, time_of_day, weekday, intent_path)
WHERE u.deleted_at IS NULL
  AND (
        CASE
            WHEN jsonb_typeof(u.preferences #> ARRAY['notif','channel','email']) = 'boolean'
            THEN (u.preferences #>> ARRAY['notif','channel','email'])::boolean
            ELSE false
        END
      ) IS TRUE
  AND (
        CASE
            WHEN jsonb_typeof(u.preferences #> v.intent_path) = 'boolean'
            THEN (u.preferences #>> v.intent_path)::boolean
            ELSE false
        END
      ) IS TRUE
ON CONFLICT ON CONSTRAINT uq_notification_schedules_user_kind_channel DO NOTHING;

-- End of 064_backfill_notification_schedules_from_prefs.up.sql — runner owns
-- the transaction (ADR-013).
