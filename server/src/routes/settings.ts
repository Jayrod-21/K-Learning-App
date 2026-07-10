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
 *     and never reaches the JSONB column. (One deliberate exception: a legacy/
 *     unknown `palette.accent` coerces to 'coral' instead of 400ing — see the
 *     AccentPreset doc-comment.) The whole blob is replaced, not merged, so a
 *     crafted partial can't smuggle extra keys past the schema.
 *   - Corrupt/legacy stored blob: a pre-schema or hand-edited blob that fails
 *     PrefsSchema.safeParse on READ falls back to DEFAULT_PREFS (logged at warn),
 *     never a 500 — the user's own bad data must not break their Settings screen.
 *   - Cost: no Claude, no external I/O — the standard cheap limiter is sufficient.
 *   - No secrets here: profile name/email/phone live in their own columns (edited
 *     via PATCH /auth/me); this blob is notif + palette + languageDisplay +
 *     textSize only, so there is nothing sensitive to leak.
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
// The preset enums are the SAME closed sets the client offers; keeping them in
// lockstep is what lets the server reject a tampered/unknown value as a 400
// instead of persisting a palette the client can't render. `accent` is the one
// deliberate exception — see its doc-comment below.
// ---------------------------------------------------------------------------

const PaperPreset = z.enum(['hanji', 'ivory', 'linen', 'sumi']);

/**
 * Accent — the Seoul-neon accent picker ids (Redesign §14a), server-synced so
 * the user's choice follows them across devices (the client stamps the value
 * as `data-accent` on `<html>`; the server only stores the id).
 *
 * `.catch('coral')` instead of the hard-400 posture the sibling enums use:
 * existing stored blobs (and stale clients mid-rolling-deploy) carry a LEGACY
 * accent id (`vermilion|indigo|plum|ochre`). A hard enum would make the
 * GET-side safeParse fail on the user's own stored blob — wiping their WHOLE
 * prefs back to DEFAULT_PREFS — and would 400 a stale client's PUT. Coercing
 * any legacy/unknown accent to the 'coral' default preserves the rest of the
 * blob on both paths; the next PUT then persists a valid id.
 */
const AccentPreset = z.enum(['coral', 'blue', 'mint']).catch('coral');

/**
 * Text size (F-025) — the app-wide root font-size scale (sm|md|lg),
 * server-synced so the choice follows the user across devices (the client
 * stamps the value as `data-text-size` on `<html>`; the server only stores
 * the id).
 *
 * `.catch('md')` for the same reason `accent` catches: every blob stored
 * before F-025 has NO `textSize` key at all, and a stale client
 * mid-rolling-deploy PUTs without one. A hard-required enum would make the
 * GET-side safeParse fail on the user's own stored blob — wiping their WHOLE
 * prefs back to DEFAULT_PREFS — and would 400 the stale client's PUT.
 * Coercing missing/unknown to the 'md' default (= the classic 16px root)
 * preserves the rest of the blob on both paths.
 */
const TextSizePreset = z.enum(['sm', 'md', 'lg']).catch('md');
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

// ---------------------------------------------------------------------------
// Language display (Overhaul P3a) — how bilingual UI CHROME renders:
//   mode     'en' | 'ko' | 'both' — which language(s) the chrome shows.
//   primary  'en' | 'ko'          — in 'both', which language is the MAIN text.
//   subScale number [0.4, 1.0]    — in 'both', the sub text's size relative to
//                                   the main (projected to a CSS var client-side).
//
// Every field carries a `.default(...)` and the whole object defaults too, so a
// stored blob written BEFORE this field existed (`{ notif, palette }`) still
// passes the GET-side safeParse and comes back with `languageDisplay` filled in
// — WITHOUT falling back to DEFAULT_PREFS and clobbering the user's stored
// palette. This is the JSONB-blob equivalent of a deep merge; no migration.
//
// Trade-off (accepted): a stale pre-P3a client PUTting `{ notif, palette }`
// passes validation and the defaults are persisted — the user's languageDisplay
// resets to 'both'. Consistent with the route's last-writer-wins posture.
// ---------------------------------------------------------------------------

const LanguageDisplayMode = z.enum(['en', 'ko', 'both']);
const BilingualLanguage = z.enum(['en', 'ko']);

export const LANG_SUB_SCALE_MIN = 0.4;
export const LANG_SUB_SCALE_MAX = 1.0;
export const LANG_SUB_SCALE_DEFAULT = 0.7;

const LanguageDisplayPrefsSchema = z
  .object({
    mode: LanguageDisplayMode.default('both'),
    primary: BilingualLanguage.default('ko'),
    // Out-of-range is a 400 on PUT (matches the palette-enum posture: reject a
    // tampered value rather than silently coerce). The client clamps before it
    // ever sends, so a rejection here means a bug or a crafted request.
    subScale: z
      .number()
      .min(LANG_SUB_SCALE_MIN)
      .max(LANG_SUB_SCALE_MAX)
      .default(LANG_SUB_SCALE_DEFAULT),
  })
  .strict();

const DEFAULT_LANGUAGE_DISPLAY: z.infer<typeof LanguageDisplayPrefsSchema> = {
  mode: 'both',
  primary: 'ko',
  subScale: LANG_SUB_SCALE_DEFAULT,
};

/** The full prefs object. `.strict()` at every level — an unknown key is a 400. */
export const PrefsSchema = z
  .object({
    notif: NotifPrefsSchema,
    palette: PalettePrefsSchema,
    languageDisplay: LanguageDisplayPrefsSchema.default(DEFAULT_LANGUAGE_DISPLAY),
    textSize: TextSizePreset,
  })
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
  palette: { paper: 'hanji', accent: 'coral', correct: 'moss', wrong: 'vermilion' },
  languageDisplay: DEFAULT_LANGUAGE_DISPLAY,
  textSize: 'md',
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
