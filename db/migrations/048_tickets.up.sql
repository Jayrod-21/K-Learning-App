-- =============================================================================
-- Migration 048 — beta ticketing / feedback (F-023, beta-blocker)
--   UP — adds `tickets` (one row per bug/concern/suggestion/request a beta
--        user files) + `ticket_comments` (threaded discussion under a ticket).
--        Powers the in-app feedback surface: a user files a ticket, everyone
--        in the beta sees the community feed ANONYMOUSLY (the route layer
--        never returns user_id/email on community reads — see
--        Repository/server/src/routes/tickets.ts), and anyone can comment.
--   Reverse: 048_tickets.down.sql
--   Depends on: 001_core_schema (users, set_updated_at()).
--
-- DESIGN NOTES
--   * `type` and `status` are TEXT + CHECK, not Postgres enums — the same call
--     012 (vocab_lists.kind) and 046 (topik_attempts.status) made: a tiny,
--     stable, table-local set stays co-located with its table, and widening is
--     a CHECK swap instead of an enum-add migration (which per ADR-013 house
--     rules must ship alone).
--   * Tickets are HARD-owned by their author: FK to users ON DELETE CASCADE
--     (mirrors vocab_lists). No soft delete — a ticket has no cross-table
--     audit trail to orphan, and the beta feedback log dying with its author
--     is the intended GDPR-ish posture for a personal app.
--   * `version` is the optimistic-concurrency token for PATCH /tickets/:id
--     (the route requires expected_version and bumps it on every UPDATE), the
--     same protocol conversations.version uses. INT4 — the route layer bounds
--     expected_version at INT4 max.
--   * Anonymity is a ROUTE-layer contract, not a schema one: user_id must stay
--     in the schema (ownership checks, cascade, "my tickets" scoping), so the
--     community feed's anonymization lives in the SELECT lists of
--     routes/tickets.ts. Nothing here should tempt a future reader to expose
--     it: no display-name column exists by design.
--   * `ticket_comments` rows are append-only (no updated_at/version — there is
--     no comment-edit endpoint; created_at is the whole story). Both FKs
--     CASCADE: a comment is meaningless without its ticket, and a departing
--     user takes their words with them.
--
-- TRANSACTION OWNERSHIP (ADR-013):
--   No top-level BEGIN/COMMIT — `migrate.py` wraps this file's body in a
--   single transaction together with the bookkeeping write.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. tickets — one row per filed bug/concern/suggestion/request
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tickets (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         BIGINT      NOT NULL,

    -- What kind of feedback this is. CHECK'd closed set; see module notes for
    -- "why not an enum".
    type            TEXT        NOT NULL,

    title           TEXT        NOT NULL,
    body            TEXT        NOT NULL,

    -- Lifecycle. Filed tickets start 'open'; the author (single-user beta —
    -- there is no admin role yet) moves them along.
    status          TEXT        NOT NULL DEFAULT 'open',

    -- Audit columns (ADR-001 D6)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    version         INTEGER     NOT NULL DEFAULT 1,

    CONSTRAINT fk_tickets_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT ck_tickets_type
        CHECK (type IN ('bug', 'concern', 'suggestion', 'request')),
    CONSTRAINT ck_tickets_status
        CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
    -- Length bounds mirror the route layer's Zod schema (defense in depth —
    -- the DB constraint is the floor the API schema must never be looser than).
    CONSTRAINT ck_tickets_title_length
        CHECK (length(title) BETWEEN 1 AND 200),
    CONSTRAINT ck_tickets_body_length
        CHECK (length(body) BETWEEN 1 AND 5000),
    CONSTRAINT ck_tickets_version_positive
        CHECK (version >= 1)
);

COMMENT ON TABLE tickets IS
    'Beta feedback tickets (F-023): bugs, concerns, suggestions, requests. '
    'Author-owned (user_id) but presented ANONYMOUSLY on community reads — '
    'the route layer (server/src/routes/tickets.ts) never returns user_id or '
    'email outside the owner''s own views.';
COMMENT ON COLUMN tickets.type IS
    'Feedback kind. CHECK constrains to bug/concern/suggestion/request; TEXT '
    '(not enum) so adding a kind later is a CHECK swap, not an ALTER TYPE.';
COMMENT ON COLUMN tickets.status IS
    'Lifecycle: open → in_progress → resolved/closed. CHECK''d closed set; '
    'transitions are route-layer policy, not a DB state machine.';
COMMENT ON COLUMN tickets.version IS
    'Optimistic-concurrency token for PATCH /tickets/:id — the route requires '
    'expected_version and bumps this on every UPDATE (conversations.version '
    'protocol).';

-- Query 1: "my tickets, most recently touched first" (GET /tickets/mine).
CREATE INDEX IF NOT EXISTS ix_tickets_user_updated
    ON tickets (user_id, updated_at DESC);
COMMENT ON INDEX ix_tickets_user_updated IS
    'Supports GET /tickets/mine — the author''s own tickets, recent first.';

-- Query 2: "the community feed, optionally filtered by status, recent first"
-- (GET /tickets/community).
CREATE INDEX IF NOT EXISTS ix_tickets_status_updated
    ON tickets (status, updated_at DESC);
COMMENT ON INDEX ix_tickets_status_updated IS
    'Supports GET /tickets/community — the anonymized all-users feed, '
    'status-filtered, recent first.';

CREATE OR REPLACE TRIGGER trg_tickets_updated_at
    BEFORE UPDATE ON tickets
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- 2. ticket_comments — append-only discussion under a ticket
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ticket_comments (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ticket_id       BIGINT      NOT NULL,
    user_id         BIGINT      NOT NULL,

    body            TEXT        NOT NULL,

    -- Append-only: no updated_at/version — comments are never edited, only
    -- added. created_at is the timestamp the feed sorts on.
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT fk_ticket_comments_ticket
        FOREIGN KEY (ticket_id) REFERENCES tickets(id)
        ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT fk_ticket_comments_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT ck_ticket_comments_body_length
        CHECK (length(body) BETWEEN 1 AND 2000)
);

COMMENT ON TABLE ticket_comments IS
    'Append-only comments under a ticket (F-023). Author-attributed in the '
    'schema (ownership + cascade) but ANONYMIZED on every community read by '
    'the route layer. Dies with its ticket AND with its author (both FKs '
    'CASCADE).';
COMMENT ON COLUMN ticket_comments.body IS 'Comment text (1–2000 chars).';

-- Query 1: "the comments of ticket X, oldest first" (GET /tickets/:id/comments).
CREATE INDEX IF NOT EXISTS ix_ticket_comments_ticket_created
    ON ticket_comments (ticket_id, created_at);
COMMENT ON INDEX ix_ticket_comments_ticket_created IS
    'Supports GET /tickets/:id/comments — a ticket''s thread in chronological '
    'order. (ticket_id, created_at) matches the ORDER BY.';

-- End of 048_tickets.up.sql — runner owns the transaction (ADR-013).
