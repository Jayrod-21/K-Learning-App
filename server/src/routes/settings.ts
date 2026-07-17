/**
 * /settings/prefs routes — server-synced app preferences (Pass 9).
 *
 * The Settings screen edits preference groups — palette / languageDisplay /
 * textSize — that previously lived only in the browser's
 * localStorage["km.settings"]. This route persists them server-side (JSONB
 * `users.preferences`, migration 018) so the choices survive a device change
 * and sync across a user's sessions.
 *
 *   GET   /settings/prefs            → the stored prefs (or defaults if
 *                                      empty/corrupt), with `notif` DERIVED
 *                                      from notification_schedules
 *   PUT   /settings/prefs            → replace the stored prefs
 *                                      (last-writer-wins); `notif` in the
 *                                      body is accepted but IGNORED
 *   PATCH /settings/prefs/tours-seen → union-merge tour ids into the stored
 *                                      `toursSeen` ONLY (jsonb_set — no
 *                                      other field carried or clobbered)
 *
 * F-093 CONTRACT step: `notif` is no longer stored in (or read from) the 018
 * blob. `notification_schedules` (052) is the single source of truth for
 * notification intent — the F-040 Settings UI edits it directly via
 * /notifications/schedules, and migration 064 backfilled any pre-existing
 * blob intent into it (the EXPAND step). This route now:
 *   - READS `notif` by deriving it from the user's schedule rows (see
 *     `deriveNotifFromSchedules` — the inverse of 064's blob→schedule
 *     mapping), never from the blob. A legacy blob's stale `notif` keys are
 *     stripped and ignored on read.
 *   - WRITES only { palette, languageDisplay, textSize } into the blob — the
 *     dual-write of duplicate notif booleans is gone. The body's `notif` is
 *     still ACCEPTED (optional) so the deployed client's full-object PUT
 *     keeps working mid-rolling-deploy; it is simply not persisted, and the
 *     echoed response carries the canonical derived value instead.
 * Dropping the blob's legacy `notif` keys from storage entirely (they still
 * sit inside pre-contract rows until the user's next PUT replaces the blob)
 * and removing the key from the client payload are the later contract steps.
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
 *     StoredPrefsSchema.safeParse on READ falls back to the stored defaults
 *     (logged at warn), never a 500 — the user's own bad data must not break
 *     their Settings screen. A malformed legacy `notif` key can no longer
 *     poison the parse at all — it is stripped before validation.
 *   - Cost: no Claude, no external I/O — the standard cheap limiter is sufficient.
 *   - No secrets here: profile name/email/phone live in their own columns (edited
 *     via PATCH /auth/me); this blob is palette + languageDisplay +
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
 * prefs back to defaults — and would 400 a stale client's PUT. Coercing
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
 * prefs back to defaults — and would 400 the stale client's PUT.
 * Coercing missing/unknown to the 'md' default (= the classic 16px root)
 * preserves the rest of the blob on both paths.
 */
const TextSizePreset = z.enum(['sm', 'md', 'lg']).catch('md');
const CorrectPreset = z.enum(['moss', 'pine', 'teal']);
const WrongPreset = z.enum(['vermilion', 'amber', 'slate']);

/**
 * Guided-tour completion marks (tutorial/product tour) — the ids of the
 * coach-mark tours the user has finished or skipped, server-synced so a seen
 * tour never re-fires on another device.
 *
 * Ids are a CLOSED set defined in the client registry (`client/src/lib/
 * tours.ts`), never user-authored input — but the server deliberately stores
 * them as opaque bounded strings instead of a hard enum: every new client
 * tour would otherwise 400 a PUT from the newer client (the exact
 * rolling-deploy failure the accent/textSize `.catch`es exist to avoid).
 * Bounds still apply: each id ≤ 64 chars, ≤ 200 ids — a crafted request
 * cannot bloat the JSONB blob unboundedly.
 *
 * `.default([])` — every blob stored before this feature has NO `toursSeen`
 * key; defaulting (the `languageDisplay` posture) means the GET-side
 * safeParse still passes and the user's palette/textSize are NOT wiped back
 * to defaults.
 *
 * PER-ELEMENT tolerance (fix-pass S4): malformed ELEMENTS are dropped
 * individually by the preprocess filter — one bad id (a number, an empty or
 * oversized string) must never discard the user's whole accumulated
 * seen-list. Unlike the accent/textSize `.catch`es (which coerce a scalar
 * PREFERENCE to a default value), this array is accumulated user DATA, so
 * the wipe radius is kept to exactly the invalid elements. The outer
 * `.catch([])` still guards the ARRAY-level failures — a non-array value or
 * a >200-element list (the anti-bloat bound, unreachable from the closed
 * client registry) coerces to "none seen" rather than failing the
 * whole-blob parse (worst case a tour re-fires once, Esc-dismissable).
 */
const TourIdElementSchema = z.string().min(1).max(64);
const ToursSeenSchema = z.preprocess(
  (v) =>
    Array.isArray(v)
      ? v.filter((el) => TourIdElementSchema.safeParse(el).success)
      : v,
  z.array(TourIdElementSchema).max(200).default([]).catch([]),
);

const PalettePrefsSchema = z
  .object({
    paper: PaperPreset,
    accent: AccentPreset,
    correct: CorrectPreset,
    wrong: WrongPreset,
  })
  .strict();

/**
 * Wire shape of the `notif` slice. F-093 CONTRACT: this is now a DERIVED,
 * read-only view over `notification_schedules` (see
 * `deriveNotifFromSchedules`) — never stored in the blob. It stays in the PUT
 * body as an OPTIONAL key purely for wire compatibility with clients that
 * still send the full pre-contract object; a malformed `notif` in the body is
 * still a 400 (strict), but a valid one is ignored.
 */
const NotifPrefsSchema = z
  .object({
    channel: z.object({ email: z.boolean(), sms: z.boolean() }).strict(),
    reviewsDue: z.boolean(),
    daily: z.boolean(),
    weekly: z.boolean(),
  })
  .strict();

type NotifPrefs = z.infer<typeof NotifPrefsSchema>;

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
// — WITHOUT falling back to defaults and clobbering the user's stored
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

/**
 * The BLOB-persisted prefs (F-093 contract): palette + languageDisplay +
 * textSize only — `notif` is neither written to nor trusted from the blob.
 * `.strict()` at every level — an unknown key is a 400 on the PUT path (the
 * GET path strips the legacy `notif` key before parsing with this schema, so
 * pre-contract rows still validate).
 */
export const StoredPrefsSchema = z
  .object({
    palette: PalettePrefsSchema,
    languageDisplay: LanguageDisplayPrefsSchema.default(DEFAULT_LANGUAGE_DISPLAY),
    textSize: TextSizePreset,
    toursSeen: ToursSeenSchema,
  })
  .strict();
export type StoredPrefs = z.infer<typeof StoredPrefsSchema>;

/**
 * The PUT body: the stored slices plus an OPTIONAL `notif` the deployed
 * client still sends. It is validated (a malformed notif is still a 400, per
 * the route's strict posture) but never persisted — see the header comment.
 */
export const PrefsSchema = StoredPrefsSchema.extend({
  notif: NotifPrefsSchema.optional(),
}).strict();
export type Prefs = z.infer<typeof PrefsSchema>;

/** The wire shape both routes respond with: stored slices + derived notif. */
type PrefsView = StoredPrefs & { notif: NotifPrefs };

/**
 * Server defaults for the STORED slices — mirror the client DEFAULT_SETTINGS.
 * Returned by GET when the stored blob is empty `{}` (the migration default for
 * existing rows) OR fails schema validation (corrupt/legacy data). `notif` has
 * no default here: it is always derived from `notification_schedules`, where a
 * fresh user's truthful state is "no schedules → nothing on" (F-040's model).
 */
const DEFAULT_STORED_PREFS: StoredPrefs = {
  palette: { paper: 'hanji', accent: 'coral', correct: 'moss', wrong: 'vermilion' },
  languageDisplay: DEFAULT_LANGUAGE_DISPLAY,
  textSize: 'md',
  toursSeen: [],
};

// ---------------------------------------------------------------------------
// notif derivation — the inverse of migration 064's blob→schedule mapping.
// ---------------------------------------------------------------------------

/**
 * Derive the wire `notif` booleans from the user's `notification_schedules`
 * rows (052 — the canonical store the F-040 Settings UI edits directly).
 *
 * Mapping (the exact inverse of what 064's backfill PRODUCES — 064 keyed on
 * the email channel because it is the only channel with real send behavior):
 *   daily / reviewsDue / weekly ← an ENABLED ('email', kind) row exists
 *   channel.email               ← ANY enabled email row exists
 *   channel.sms                 ← ANY enabled sms row exists (placeholder
 *                                 channel — stored, never sent; F-040)
 * A user with no rows derives all-false: nothing is implicitly on.
 *
 * NOT a round-trip of arbitrary pre-064 blob state. Three legacy blob classes
 * were deliberately dropped by 064 itself (documented in its header), so they
 * read differently here than the old blob-sourced GET did — expected, not a
 * derivation bug:
 *   1. `channel.email: true` with all three kinds false → 064 inserted no
 *      rows → derives `email: false` (blob said true).
 *   2. `channel.sms: true` → 064 never backfilled sms → derives `sms: false`
 *      (blob said true), unless the user has since created enabled sms rows
 *      via PUT /notifications/schedules.
 *   3. Any kind true with `channel.email: false` → 064's email gate skipped
 *      it → derives that kind false (blob said true).
 * None of these states could ever have produced a send, and no client or
 * server consumer renders or acts on these booleans (verified exhaustively in
 * the F-093 contract review), so the drift is wire-only.
 *
 * Note also: the kind booleans key on the email channel ONLY, so an enabled
 * 'push' row (creatable via PUT /notifications/schedules — `ScheduleChannel`
 * in routes/notifications.ts) is invisible in daily/reviewsDue/weekly. This
 * mirrors 064's email-only mapping and the email-only F-040 client; revisit
 * if push ever gains real send behavior.
 */
async function deriveNotifFromSchedules(userId: number): Promise<NotifPrefs> {
  const { rows } = await query<{ kind: string; channel: string; enabled: boolean }>(
    `SELECT kind, channel, enabled
       FROM notification_schedules
      WHERE user_id = $1`,
    [userId],
  );
  const enabledEmailKind = (kind: string): boolean =>
    rows.some((r) => r.channel === 'email' && r.kind === kind && r.enabled);
  return {
    channel: {
      email: rows.some((r) => r.channel === 'email' && r.enabled),
      sms: rows.some((r) => r.channel === 'sms' && r.enabled),
    },
    reviewsDue: enabledEmailKind('reviews_due'),
    daily: enabledEmailKind('daily_reminder'),
    weekly: enabledEmailKind('weekly_report'),
  };
}

/**
 * Parse a stored blob into the stored slices, tolerating (and discarding) the
 * legacy `notif` key that pre-contract rows still carry. Returns null when
 * the remainder fails validation — the caller serves defaults.
 */
function parseStoredPrefs(blob: unknown): StoredPrefs | null {
  let candidate = blob;
  if (candidate !== null && typeof candidate === 'object' && 'notif' in candidate) {
    // Strip WITHOUT validating: a malformed legacy notif must not be able to
    // wipe the user's palette back to defaults — it is dead data either way.
    const { notif: _legacyNotif, ...rest } = candidate as Record<string, unknown>;
    candidate = rest;
  }
  const parsed = StoredPrefsSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// GET /settings/prefs — stored slices (or defaults) + derived notif.
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
    // notif is ALWAYS derived from notification_schedules (F-093 contract) —
    // on every branch below, including the defaults fallbacks, so no path can
    // reintroduce a second source of truth.
    const notif = await deriveNotifFromSchedules(userId);

    // A soft-deleted / missing user behind a still-valid session is not expected
    // (requireAuth resolved the user), but if the row is gone we serve defaults
    // rather than 404 — the Settings screen should always render something.
    if (!row) {
      const view: PrefsView = { notif, ...DEFAULT_STORED_PREFS };
      res.status(200).json(view);
      return;
    }

    // Validate the stored blob through the SAME schema we persist on write
    // (legacy notif keys stripped first). An empty `{}` (migration default) or
    // a legacy/corrupt shape fails and we fall back to the stored defaults —
    // NEVER 500 on the user's own bad data.
    const stored = parseStoredPrefs(row.preferences);
    if (stored === null) {
      req.log?.warn({ userId }, 'stored preferences failed schema; serving defaults');
      const view: PrefsView = { notif, ...DEFAULT_STORED_PREFS };
      res.status(200).json(view);
      return;
    }
    const view: PrefsView = { notif, ...stored };
    res.status(200).json(view);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PUT /settings/prefs — replace the stored prefs (last-writer-wins).
// ---------------------------------------------------------------------------

router.put('/prefs', cheapLimiter(), validateBody(PrefsSchema), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const body = req.body as Prefs;
    // F-093 contract: persist ONLY the stored slices — the body's `notif` (if
    // present) is deliberately dropped here, ending the dual-write. The echo
    // below carries the CANONICAL notif derived from notification_schedules,
    // not whatever the client sent.
    const stored: StoredPrefs = {
      palette: body.palette,
      languageDisplay: body.languageDisplay,
      textSize: body.textSize,
      toursSeen: body.toursSeen,
    };

    // Write the WHOLE stored object (no merge, no version gate). Last-writer-wins
    // is the locked decision: the Settings screen debounces a full-object PUT on
    // every change, so two concurrent saves simply resolve to whichever lands
    // last — there is no field-level conflict to reconcile. The `deleted_at IS
    // NULL` predicate keeps a soft-deleted account from being written to. (If
    // the row is gone/soft-deleted by the time we write — session resolved a
    // user, rowCount 0 — we still echo rather than 404 an authenticated
    // Settings save; the response shape is identical either way.)
    await query(
      `UPDATE users
          SET preferences = $1::jsonb
        WHERE id = $2 AND deleted_at IS NULL`,
      [JSON.stringify(stored), userId],
    );

    // Echo what persisted + the canonical notif, so the client's local state
    // converges on the single source of truth.
    const view: PrefsView = { notif: await deriveNotifFromSchedules(userId), ...stored };
    res.status(200).json(view);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PATCH /settings/prefs/tours-seen — field-scoped, union-merge write.
// ---------------------------------------------------------------------------

const ToursSeenPatchSchema = z.object({ toursSeen: ToursSeenSchema }).strict();

/**
 * Field-scoped tour-marks sync (fix-pass S3). `TourProvider` used to sync a
 * finished tour via GET → merge → full-blob PUT, which carried the GET-time
 * palette/languageDisplay/textSize — any prefs write landing inside that
 * GET→PUT window (e.g. Settings' debounced accent PUT racing "Skip all
 * tours") was silently reverted. This route removes that exposure class
 * structurally: the ids are UNION-merged with the stored list server-side
 * and written with `jsonb_set` on the CURRENT column value, so no other
 * prefs field is ever carried — a concurrent palette PUT cannot be
 * clobbered by a tour mark, full stop.
 *
 * Residual race (documented, accepted): two concurrent writers of
 * `toursSeen` ITSELF (a full PUT racing this PATCH, or two tabs marking
 * different tours) still resolve last-writer-wins on this one field — an id
 * can transiently drop server-side. Self-healing: every device keeps its
 * own marks in localStorage and re-unions them on its next mark/boot sync,
 * so the set only ever converges upward. A version gate/CAS is deliberately
 * out of scope (the route's locked last-writer-wins posture).
 *
 * Union-merge (never replace) also means this endpoint cannot SHRINK the
 * list — "unsee" doesn't exist in the product (replay ignores seen state),
 * so a monotonic grow-only write is the safest primitive to expose.
 */
router.patch(
  '/prefs/tours-seen',
  cheapLimiter(),
  validateBody(ToursSeenPatchSchema),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const { toursSeen } = req.body as z.infer<typeof ToursSeenPatchSchema>;
      const { rows } = await query<{ preferences: unknown }>(
        `SELECT preferences
           FROM users
          WHERE id = $1 AND deleted_at IS NULL`,
        [userId],
      );
      const stored = rows[0] ? parseStoredPrefs(rows[0].preferences) : null;
      const base = stored ?? DEFAULT_STORED_PREFS;
      // Sorted for deterministic storage; capped so a stored-∪-body union can
      // never exceed the anti-bloat bound and trip the GET-side `.catch([])`
      // whole-list coercion (unreachable from the 11-id client registry —
      // defense against a crafted 200+200 union).
      const merged = [...new Set([...base.toursSeen, ...toursSeen])]
        .sort()
        .slice(0, 200);

      if (stored !== null) {
        // Valid blob: touch ONLY the toursSeen key. `jsonb_set` operates on
        // the column's value AT WRITE TIME (single atomic UPDATE), so a
        // palette/textSize write landing since our SELECT survives intact.
        // The `jsonb_typeof` predicate guards the read-to-write window
        // against the blob having been replaced with a non-object; rowCount
        // 0 then simply means the mark retries on the client's next sync.
        await query(
          `UPDATE users
              SET preferences = jsonb_set(preferences, '{toursSeen}', $1::jsonb, true)
            WHERE id = $2 AND deleted_at IS NULL
              AND jsonb_typeof(preferences) = 'object'`,
          [JSON.stringify(merged), userId],
        );
      } else {
        // Empty `{}` (migration default) or corrupt blob: there is nothing
        // recoverable to preserve, so persist a full valid blob (stored
        // defaults + the merged marks). Without this, `jsonb_set` on `{}`
        // would store a palette-less blob the GET-side parse rejects — the
        // marks would be written but never served.
        await query(
          `UPDATE users
              SET preferences = $1::jsonb
            WHERE id = $2 AND deleted_at IS NULL`,
          [JSON.stringify({ ...DEFAULT_STORED_PREFS, toursSeen: merged }), userId],
        );
      }

      // Same view shape as GET/PUT: the (unchanged) stored slices with the
      // merged marks + the canonical derived notif, so the client can adopt
      // ids another device persisted without a follow-up GET.
      const view: PrefsView = {
        notif: await deriveNotifFromSchedules(userId),
        ...base,
        toursSeen: merged,
      };
      res.status(200).json(view);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
