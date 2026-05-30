/**
 * /settings/prefs routes — server-synced app preferences (Pass 9).
 *
 * The Settings screen edits two preference groups — notifications + palette —
 * that previously lived only in the browser's localStorage["km.settings"]. This
 * route persists them server-side (JSONB `users.preferences`, migration 018) so
 * the choices survive a device change and sync across a user's sessions.
 *
 *   GET /settings/prefs  → the stored prefs (or DEFAULT_PREFS if empty/corrupt)
 *   PUT /settings/prefs  → replace the whole prefs object (last-writer-wins)
 *
 * SECURITY (see SECURITY.md §17 — this is a low-surface, cheap, authed route):
 *   - IDOR: every query is scoped to `getUserId(req)`; a user can only ever read
 *     or write their OWN row. There is no :id in the path — the subject is always
 *     the session user — so cross-user access is structurally impossible.
 *   - Mass-assignment / unknown-key injection: PrefsSchema is `.strict()` at
 *     every level, so an unknown key or a bad enum is a clean 400 (validateBody)
 *     and never reaches the JSONB column. The whole blob is replaced, not
 *     merged, so a crafted partial can't smuggle extra keys past the schema.
 *   - Corrupt/legacy stored blob: a pre-schema or hand-edited blob that fails
 *     PrefsSchema.safeParse on READ falls back to DEFAULT_PREFS (logged at warn),
 *     never a 500 — the user's own bad data must not break their Settings screen.
 *   - Cost: no Claude, no external I/O — the standard cheap limiter is sufficient.
 *   - No secrets here: profile name/email/phone live in their own columns (edited
 *     via PATCH /auth/me); this blob is notif + palette only, so there is nothing
 *     sensitive to leak.
 */
import { Router } from 'express';
import { z } from 'zod';
import { getUserId, requireAuth } from '../middleware/auth.js';
import { cheapLimiter } from '../middleware/rateLimits.js';
import { validateBody } from '../middleware/validate.js';
import { query } from '../db/pool.js';

const router = Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// PrefsSchema — mirrors the client domain.ts NotifPrefs/PalettePrefs EXACTLY.
//
// The preset enums are the SAME closed sets the client's palette picker offers;
// keeping them in lockstep is what lets the server reject a tampered/unknown
// value as a 400 instead of persisting a palette the client can't render.
// ---------------------------------------------------------------------------

const PaperPreset = z.enum(['hanji', 'ivory', 'linen', 'sumi']);
const AccentPreset = z.enum(['vermilion', 'indigo', 'plum', 'ochre']);
const CorrectPreset = z.enum(['moss', 'pine', 'teal']);
const WrongPreset = z.enum(['vermilion', 'amber', 'slate']);

const PalettePrefsSchema = z
  .object({
    paper: PaperPreset,
    accent: AccentPreset,
    correct: CorrectPreset,
    wrong: WrongPreset,
  })
  .strict();

const NotifPrefsSchema = z
  .object({
    channel: z.object({ email: z.boolean(), sms: z.boolean() }).strict(),
    reviewsDue: z.boolean(),
    daily: z.boolean(),
    weekly: z.boolean(),
  })
  .strict();

/** The full prefs object. `.strict()` at every level — an unknown key is a 400. */
export const PrefsSchema = z
  .object({ notif: NotifPrefsSchema, palette: PalettePrefsSchema })
  .strict();
export type Prefs = z.infer<typeof PrefsSchema>;

/**
 * Server defaults — mirror the client DEFAULT_SETTINGS (notif + palette only).
 * Returned by GET when the stored blob is empty `{}` (the migration default for
 * existing rows) OR fails schema validation (corrupt/legacy data). This is the
 * single source of truth the client falls back to when the server is reachable
 * but the row carries no usable prefs yet.
 */
const DEFAULT_PREFS: Prefs = {
  notif: { channel: { email: true, sms: false }, reviewsDue: true, daily: false, weekly: true },
  palette: { paper: 'hanji', accent: 'vermilion', correct: 'moss', wrong: 'vermilion' },
};

// ---------------------------------------------------------------------------
// GET /settings/prefs — the user's stored prefs, or DEFAULT_PREFS.
// ---------------------------------------------------------------------------

router.get('/prefs', cheapLimiter(), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { rows } = await query<{ preferences: unknown }>(
      `SELECT preferences
         FROM users
        WHERE id = $1 AND deleted_at IS NULL`,
      [userId],
    );
    const row = rows[0];
    // A soft-deleted / missing user behind a still-valid session is not expected
    // (requireAuth resolved the user), but if the row is gone we serve defaults
    // rather than 404 — the Settings screen should always render something.
    if (!row) {
      res.status(200).json(DEFAULT_PREFS);
      return;
    }

    // Validate the stored blob through the SAME schema we accept on write. An
    // empty `{}` (migration default) or a legacy/corrupt shape fails here and we
    // fall back to DEFAULT_PREFS — NEVER 500 on the user's own bad data.
    const parsed = PrefsSchema.safeParse(row.preferences);
    if (!parsed.success) {
      req.log?.warn(
        { userId, issues: parsed.error.issues.map((i) => i.path.join('.')) },
        'stored preferences failed schema; serving DEFAULT_PREFS',
      );
      res.status(200).json(DEFAULT_PREFS);
      return;
    }
    res.status(200).json(parsed.data);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PUT /settings/prefs — replace the whole prefs object (last-writer-wins).
// ---------------------------------------------------------------------------

router.put('/prefs', cheapLimiter(), validateBody(PrefsSchema), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const prefs = req.body as Prefs;

    // Write the WHOLE object (no merge, no version gate). Last-writer-wins is the
    // locked decision: the Settings screen debounces a full-object PUT on every
    // change, so two concurrent saves simply resolve to whichever lands last —
    // there is no field-level conflict to reconcile. The `deleted_at IS NULL`
    // predicate keeps a soft-deleted account from being written to.
    const { rowCount } = await query(
      `UPDATE users
          SET preferences = $1::jsonb
        WHERE id = $2 AND deleted_at IS NULL`,
      [JSON.stringify(prefs), userId],
    );
    if (rowCount !== 1) {
      // The session resolved a user but the row is gone/soft-deleted by the time
      // we write. Echo the validated body so the client still has a coherent
      // local state; we deliberately do not 404 a authenticated Settings save.
      res.status(200).json(prefs);
      return;
    }
    // Echo the stored object so the client confirms exactly what persisted.
    res.status(200).json(prefs);
  } catch (err) {
    next(err);
  }
});

export default router;
