-- migrate: destructive
-- 064 (down): remove exactly the rows this backfill could have inserted, and
-- NO OTHERS.
--
-- LOSSY: any row this migration created is deleted (that IS the intent — the
-- rollback of a data backfill is undoing the data it inserted). Declared
-- destructive explicitly (F-088) since a bare DELETE has no DROP TABLE/SCHEMA/
-- DATABASE or TRUNCATE keyword for the legacy sniff to catch — this is
-- exactly the shape (mass DELETE) F-088 was written to close.
--
-- SAFETY — why this does NOT also delete a real user's post-backfill edit:
-- the WHERE clause mirrors the up-migration's own predicate (same
-- channel.email + kind-intent derivation from the blob) AND additionally
-- requires `created_at = updated_at` (never UPDATEd since insertion). A user
-- who visited /notifications/schedules after the backfill and changed
-- anything about that row bumps `updated_at` (the 052 trigger), which
-- excludes it here — their edit survives the rollback. A row this migration
-- never touched (the user already had one before 064 ran) never matches the
-- blob-derived predicate's ON CONFLICT DO NOTHING outcome in the first place
-- in the sense that mattered at insert time, but IS still excluded here if it
-- happens to coincidentally match the shape, by the same created_at=updated_at
-- guard — a pre-existing untouched row would have to have been created by a
-- prior real PUT, which the F-040 route always leaves in the exact same
-- untouched-since-creation state until the NEXT PUT bumps updated_at, so this
-- guard alone cannot perfectly distinguish "backfilled" from "created by a
-- single real PUT that was never edited again". This is the accepted
-- imprecision of a data-migration's down (see db/migrations/README.md's
-- data-vs-schema rollback guidance) — the same posture 046.down documents for
-- its own unmatched DELETEs.
--
-- ADR-013: no top-level BEGIN/COMMIT — the runner owns the transaction.

DELETE FROM notification_schedules ns
USING users u
CROSS JOIN LATERAL (
    VALUES
        ('daily_reminder', ARRAY['notif','daily']::text[]),
        ('reviews_due',    ARRAY['notif','reviewsDue']::text[]),
        ('weekly_report',  ARRAY['notif','weekly']::text[])
) AS v(kind, intent_path)
WHERE ns.user_id = u.id
  AND ns.channel = 'email'
  AND ns.kind = v.kind
  AND ns.created_at = ns.updated_at
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
      ) IS TRUE;

-- End of 064_backfill_notification_schedules_from_prefs.down.sql
