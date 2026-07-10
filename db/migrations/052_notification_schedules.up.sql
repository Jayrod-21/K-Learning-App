-- =============================================================================
-- Migration 052 — notification schedules + delivery log (F-040; supersedes F-006)
--   UP — creates the persistence layer for user-selectable notification timing:
--          1. notification_schedules — one row per (user, kind, channel):
--             WHEN a daily_reminder / reviews_due / weekly_report notification
--             fires, on WHICH channel (push/email/sms), and whether it is
--             enabled. This replaces the timing-less boolean INTENT that lives
--             in the users.preferences JSONB blob (migration 018, Settings
--             notif toggles) with real, per-kind schedules.
--          2. notification_deliveries — an append-only send log keyed to a
--             schedule, for idempotency ("did today's 07:30 reminder already
--             go out?") and audit once the sender lands. NO sender/worker
--             ships in this migration's phase — the tables are the contract
--             the later send phase builds against.
--   Reverse: 052_notification_schedules.down.sql (drops both tables — LOSSY).
--   Depends on: 001_core_schema (users, set_updated_at()).
--
-- DESIGN NOTES
--   * A TABLE, not more keys in the 018 preferences blob: a schedule is
--     row-shaped (queried per-kind by a future sender doing "everything due at
--     minute X"), carries its own lifecycle (enabled, updated_at, version),
--     and the delivery log needs a stable FK target. The blob stays the store
--     for palette/textSize/languageDisplay; its notif booleans remain until
--     the Settings UI migrates onto this API, then become dead keys (the blob
--     is schema-validated at the route, so stale keys are harmless).
--   * kind / channel / status are TEXT + CHECK, not enums — the 015/046 call:
--     tiny, table-local sets stay co-located with their table, and widening
--     is a CHECK swap instead of an enum-add migration.
--   * `sms` is a PLACEHOLDER channel (F-040): accepted and stored so the user
--     choice persists, but no SMS infrastructure exists and none ships here.
--     The DB deliberately does not care — placeholder-ness is a route/sender
--     concern, and blessing sms in the CHECK now avoids a CHECK-swap
--     migration when SMS sending becomes real.
--   * weekday is 0=Sunday .. 6=Saturday (JS Date.getDay() convention — the
--     client and the future sender are both JS). The CHECK ties it to kind:
--     weekly_report REQUIRES a weekday (a weekly schedule without a day is
--     unschedulable garbage), daily kinds must NOT carry one (a stale weekday
--     on a row later re-pointed to daily would be a lurking bug).
--   * time_of_day is TIME (no zone) + tz TEXT: "07:30 in Asia/Seoul" is the
--     user's mental model and survives DST correctly, which a single
--     timestamptz cannot. tz validity (IANA name) is enforced at the route —
--     a CHECK cannot consult pg_timezone_names (not immutable) — the DB only
--     guards shape (non-empty, bounded).
--   * UNIQUE (user_id, kind, channel): one schedule per kind per channel is
--     the F-040 model ("for each of the 3 types, pick when + which channels").
--     Its backing index LEADS on user_id, so it also serves the route's only
--     read ("this user's schedules") — a separate ix on (user_id) would be a
--     fully redundant prefix duplicate and is deliberately not created.
--   * notification_deliveries has created_at only — an append-only log row is
--     written once by the (future) sender and then only its status/sent_at
--     flip on completion; no updated_at trigger or version column (the 040
--     book_pages posture for derived/log rows). ON DELETE CASCADE: a delivery
--     record is meaningless without its schedule, and per-user erasure via
--     users → schedules → deliveries must not strand audit rows.
--   * status='sent' must carry sent_at (CHECK) — an idempotency probe that
--     finds a 'sent' row with no timestamp cannot answer "sent WHEN?", which
--     is the only question the log exists to answer.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — migrate.py wraps this file's body in a single
--   transaction together with the bookkeeping write.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. notification_schedules — WHEN each notification kind fires, per channel.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification_schedules (
    id              BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         BIGINT      NOT NULL,

    -- What fires: the three F-040 notification types.
    kind            TEXT        NOT NULL,
    -- Where it goes. 'sms' is a stored PLACEHOLDER (no send infra yet).
    channel         TEXT        NOT NULL,

    -- Local wall-clock time in `tz` (user's mental model; DST-correct).
    time_of_day     TIME        NOT NULL,
    -- IANA zone name (e.g. 'Asia/Seoul'). Validity enforced at the route.
    tz              TEXT        NOT NULL,
    -- 0=Sunday .. 6=Saturday (JS Date.getDay()). Required for weekly_report,
    -- forbidden otherwise — see ck_notification_schedules_weekday_by_kind.
    weekday         SMALLINT,

    enabled         BOOLEAN     NOT NULL DEFAULT true,

    -- Audit columns (ADR-001 §D6). updated_at is maintained by the trigger below.
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    version         INTEGER     NOT NULL DEFAULT 1,

    CONSTRAINT fk_notification_schedules_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE RESTRICT,
    -- One schedule per (user, kind, channel). The backing index leads on
    -- user_id and doubles as the "this user's schedules" lookup index.
    CONSTRAINT uq_notification_schedules_user_kind_channel
        UNIQUE (user_id, kind, channel),
    CONSTRAINT ck_notification_schedules_kind
        CHECK (kind IN ('daily_reminder', 'reviews_due', 'weekly_report')),
    CONSTRAINT ck_notification_schedules_channel
        CHECK (channel IN ('push', 'email', 'sms')),
    CONSTRAINT ck_notification_schedules_tz_shape
        CHECK (length(tz) BETWEEN 1 AND 64),
    -- weekday ⟷ kind: weekly_report requires one (0..6); daily kinds must
    -- not carry one.
    CONSTRAINT ck_notification_schedules_weekday_by_kind
        CHECK (
            (kind =  'weekly_report' AND weekday IS NOT NULL
                                     AND weekday BETWEEN 0 AND 6)
         OR (kind <> 'weekly_report' AND weekday IS NULL)
        ),
    CONSTRAINT ck_notification_schedules_version_positive
        CHECK (version >= 1)
);

COMMENT ON TABLE notification_schedules IS
    'Per-user notification timing (F-040, supersedes F-006): one row per '
    '(user, kind, channel) saying WHEN a daily_reminder / reviews_due / '
    'weekly_report fires and on which channel. Replaces the timing-less '
    'notif booleans inside users.preferences (018). sms rows are stored '
    'placeholders — no send infrastructure exists yet; the sender/worker is '
    'a later phase and will consume this table.';
COMMENT ON COLUMN notification_schedules.kind IS
    'Notification type: daily_reminder (study nudge), reviews_due (SRS '
    'reviews waiting), weekly_report (progress digest).';
COMMENT ON COLUMN notification_schedules.channel IS
    'Delivery channel. push/email/sms; sms is a PLACEHOLDER (F-040) — '
    'accepted + stored, never sent until the SMS phase lands.';
COMMENT ON COLUMN notification_schedules.time_of_day IS
    'Local wall-clock send time in `tz` (minute precision by route contract). '
    'TIME + tz, not timestamptz — survives DST the way the user expects.';
COMMENT ON COLUMN notification_schedules.tz IS
    'IANA time-zone name (e.g. ''Asia/Seoul''). The route validates it '
    'resolves (Intl); the DB only guards shape — a CHECK cannot consult '
    'pg_timezone_names.';
COMMENT ON COLUMN notification_schedules.weekday IS
    '0=Sunday .. 6=Saturday (JS Date.getDay()). NOT NULL iff '
    'kind=''weekly_report'' — enforced by '
    'ck_notification_schedules_weekday_by_kind.';
COMMENT ON CONSTRAINT uq_notification_schedules_user_kind_channel
    ON notification_schedules IS
    'One schedule per (user, kind, channel) — the F-040 upsert key (PUT '
    '/notifications/schedules arbiters on it). Leading on user_id, its index '
    'also serves the per-user list read; no separate (user_id) index needed.';

CREATE OR REPLACE TRIGGER trg_notification_schedules_updated_at
    BEFORE UPDATE ON notification_schedules
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- 2. notification_deliveries — append-only send log (idempotency + audit).
--    Written by the FUTURE sender phase; created empty here so the send
--    contract is settled before any worker exists.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification_deliveries (
    id              BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    schedule_id     BIGINT      NOT NULL,

    -- When the message actually left. NULL while pending/failed/skipped.
    sent_at         TIMESTAMPTZ,
    status          TEXT        NOT NULL DEFAULT 'pending',
    -- Opaque provider message id (SES/Twilio/web-push receipt) for tracing.
    provider_ref    TEXT,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT fk_notification_deliveries_schedule
        FOREIGN KEY (schedule_id) REFERENCES notification_schedules(id)
        ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT ck_notification_deliveries_status
        CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
    -- A 'sent' row without a timestamp cannot answer "sent when?" — the one
    -- question an idempotency/audit log exists to answer.
    CONSTRAINT ck_notification_deliveries_sent_has_sent_at
        CHECK (status <> 'sent' OR sent_at IS NOT NULL),
    CONSTRAINT ck_notification_deliveries_provider_ref_shape
        CHECK (provider_ref IS NULL OR length(provider_ref) BETWEEN 1 AND 255)
);

COMMENT ON TABLE notification_deliveries IS
    'Append-only per-schedule send log (F-040). The future sender inserts a '
    '''pending'' row as its idempotency claim for a given firing, then flips '
    'it to sent/failed/skipped. Empty until that phase ships. CASCADE from '
    'notification_schedules: a delivery record is meaningless without its '
    'schedule, and user-erasure must not strand audit rows.';
COMMENT ON COLUMN notification_deliveries.status IS
    'pending (claimed, in flight) → sent | failed | skipped (e.g. schedule '
    'disabled between claim and send, or nothing due to report).';
COMMENT ON COLUMN notification_deliveries.provider_ref IS
    'Opaque provider message id/receipt (SES, Twilio, web-push endpoint '
    'response) for support tracing. NULL until a real send succeeds.';

-- Query shape: "the recent deliveries of schedule X" (idempotency probe:
-- newest delivery for a schedule within the current firing window).
CREATE INDEX IF NOT EXISTS ix_notification_deliveries_schedule_created
    ON notification_deliveries (schedule_id, created_at DESC);
COMMENT ON INDEX ix_notification_deliveries_schedule_created IS
    'Supports the sender''s idempotency probe — the newest delivery rows of '
    'one schedule (F-040 send phase).';

-- End of 052_notification_schedules.up.sql — runner owns the transaction (ADR-013).
