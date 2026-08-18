/**
 * /plan routes — the daily study plan that drives the Today screen.
 *
 * `GET /plan/today` composes one response from data that already lives in the
 * database — no new user-state is written here, the endpoint is a pure read:
 *
 *   {
 *     dueCount:   number,                      // FSRS cards due as of now()
 *                                              // (hanja cards excluded until
 *                                              // the F-075 review UI ships)
 *     reading:    TodayTask | null,            // one of THIS user's own
 *                                              // reading_chapters / stories
 *     listening:  TodayTask | null,            // one Iyagi episode
 *     writing:    TodayTask | null,            // one writing_prompts row
 *     largestGap: 'Reading'|'Listening'|'Writing'|null   // weakest modality
 *     recommendation: Recommendation | null,   // F-212 P4 (additive): the
 *                                              // evidence-driven "do this
 *                                              // next" pick; null on cold
 *                                              // start (client keeps tiles)
 *     alternatives?: Recommendation[]          // runner-up dimensions' picks
 *                                              // (present iff recommendation)
 *   }
 *
 * WAVE 2 (backend batch, TODAY_NAV_SCOPING.md B4/B5/B6): three additive
 * changes so the Today screen's tiles can deep-link to the EXACT item they
 * display, instead of the bare landing page:
 *   1. Reading is re-sourced from `reading_chapters` (uploaded-book chapters)
 *      and `generated_stories` (AI-generated stories) — the domain the
 *      `/learn/reading` page actually serves — replacing the old
 *      `ttmik_lessons` pick, which had no relationship to that page at all
 *      (B4 Option 2). `reading.sourceKind`/`chapterId`/`storyId` ride along so
 *      the tile can navigate to `?chapter=<id>` or `?story=<id>`.
 *   2. `listening.corpus`/`episodeNumber` carry the Iyagi episode's natural
 *      key (distinct from its internal DB id) so the tile can navigate to
 *      `?corpus=iyagi&episode=<episodeNumber>` (B5).
 *   3. `writing.promptId` carries the `writing_prompts.id` (and, F-134,
 *      `writing.promptKr` the full prompt body for the tile's preview) so the tile can
 *      request this EXACT bank prompt instead of a fresh random draw (B6).
 * All three are purely additive JSON fields on the existing nested
 * `reading`/`listening`/`writing` objects — no shape is renamed or removed,
 * safe for the shared blue/green `km-db`.
 *
 * SELECTION MODEL — "stable per user per day, leveled to ability"
 *   Each content task (reading / listening / writing) is picked by ordering on
 *   `md5(user_id || seoul_date || row_id)`, where `seoul_date` is the current
 *   date in 'Asia/Seoul' (see `PLAN_DATE_SQL`). Two consequences, both deliberate:
 *     1. Deterministic within a day — refetching Today (e.g. the screen's
 *        retry, or a second device) returns the SAME plan, so the user never
 *        sees the day's tasks reshuffle under them.
 *     2. Rolls over at midnight in 'Asia/Seoul' — the app's target locale (a
 *        Korea-resident learner on a self-hosted server). The boundary is
 *        pinned with `(now() AT TIME ZONE 'Asia/Seoul')::date` rather than the
 *        bare `current_date`, which would evaluate in the DB session timezone
 *        (UTC on a stock container) and reshuffle the plan at 09:00 KST. The
 *        pin makes rollover deterministic and session-TZ-independent, with no
 *        cron or stored "plan of the day" row.
 *   When the user has a diagnostic snapshot, the reading/writing branches
 *   PREFER a row whose difficulty band matches that modality's estimate
 *   (band-match sorts first, deterministic hash breaks ties), so content is
 *   leveled to current ability. No snapshot → pure deterministic-random.
 *   Reading's band-match (Wave 2) can only ever prefer a `generated_stories`
 *   row — `reading_chapters` carries no proficiency band at all — so a
 *   chapter is always a fallback-tier candidate, same tie-break shape as the
 *   writing branch's own CASE.
 *
 * `largestGap` is the weakest of the three *surfaced* modalities (reading /
 * listening / writing) in the latest snapshot — it drives which Today tile
 * wears the "Largest gap" highlight. Null when the user has no snapshot yet.
 *
 * THREAT MODEL
 *   - Auth required (requireAuth) — the plan is user-specific (due count +
 *     snapshot-leveled content). No body, no params: zero injection surface
 *     beyond the parameterized `user_id`, which comes from the session, never
 *     the client.
 *   - Read-only: no INSERT/UPDATE. A botched client retry is fully safe and
 *     idempotent within the day (same plan returned).
 *   - Rate limit: cheapLimiter (per-user) — the endpoint runs ~5 small indexed
 *     queries; the limiter caps abusive polling.
 *   - All title/level strings are returned as data and rendered as React
 *     children client-side (escaped) — no HTML is ever emitted here.
 *   - Wave 2's reading re-source (unlike the old ttmik_lessons pick, which
 *     was PUBLIC corpus data) reads two USER-OWNED tables — every row is
 *     scoped `WHERE user_id = $1` (the session's own id), so this endpoint
 *     can never surface, or leak the existence of, another user's uploaded
 *     book chapters or generated stories.
 */
import { Router } from 'express';
import { getUserId, requireAuth } from '../middleware/auth.js';
import { cheapLimiter } from '../middleware/rateLimits.js';
import { query } from '../db/pool.js';
import { getLogger } from '../logging.js';
import { estimateAbility } from '../services/ability/estimate.js';
import { fetchCandidates } from '../services/ability/candidates.js';
import {
  rankRecommendations,
  targetDifficulty,
  type DimensionSignal,
  type RecommendDimension,
  type Recommendation,
} from '../services/ability/recommend.js';

const router = Router();
router.use(requireAuth);

/**
 * The day-rollover boundary expression used in every selection hash. Pinned to
 * the app's target locale ('Asia/Seoul') so rollover is at local midnight
 * regardless of the DB session timezone — a bare `current_date` evaluates in
 * the session's TimeZone GUC (UTC on a stock container), which would reshuffle
 * the plan at 09:00 KST for a Korea-resident user.
 *
 * Built from a timestamp expression (default `now()`) so the regression test
 * can exercise THIS EXACT production expression against a fixed instant — see
 * `planDateSql` usage in `tests/routes/plan.test.ts`. Both the timestamp source
 * and the zone are server-side SQL, not interpolated client input — no
 * injection surface (the `tsExpr` argument is only ever a trusted literal).
 */
export function planDateSql(tsExpr = 'now()'): string {
  return `(${tsExpr} AT TIME ZONE 'Asia/Seoul')::date::text`;
}

const PLAN_DATE_SQL = planDateSql();

/**
 * The `reading_chapters ∪ generated_stories` candidate UNION — the personal
 * reading corpus the Wave-2 pick (below) selects from. Extracted to a shared
 * helper (F-212 P4) so the ability recommender's reading candidate generator
 * (services/ability/candidates.ts) reuses THIS EXACT source query instead of
 * growing a parallel one that could drift; the interpolated text is unchanged
 * from the original inline form, so the Wave-2 selection query is byte-for-
 * byte what it was.
 *
 * `userParam` is the caller's placeholder for the session user id (e.g.
 * `'$1'`) — only ever a trusted literal, same contract as `planDateSql`'s
 * `tsExpr`: no injection surface. Both legs are scoped to it (user-owned
 * tables — see the THREAT MODEL note above).
 */
export function readingCandidatesUnionSql(userParam: string): string {
  return `SELECT 'chapter'::text AS source_kind,
                c.id AS row_id,
                c.title,
                c.chapter_number,
                NULL::text AS level,
                (SELECT COALESCE(sum(length(p.body)), 0)::int
                   FROM reading_passages p
                  WHERE p.chapter_id = c.id) AS char_count
           FROM reading_chapters c
          WHERE c.user_id = ${userParam}
          UNION ALL
         SELECT 'story'::text AS source_kind,
                s.id AS row_id,
                s.title,
                NULL::int AS chapter_number,
                s.level::text AS level,
                length(s.body_ko) AS char_count
           FROM generated_stories s
          WHERE s.user_id = ${userParam}`;
}

// ---------------------------------------------------------------------------
// Pure derivation helpers (exported for unit testing — no DB dependency).
// ---------------------------------------------------------------------------

/** Korean-speech-level / TOPIK-band label the client renders on a task tile. */
export type LevelLabel = 'L3' | 'L4' | 'L5+' | 'L3→L4';

/** proficiency_level enum values used by writing_prompts.level. */
export type Proficiency = 'basic' | 'L3' | 'L4' | 'L5+';

/** The three modalities a Today plan highlights a gap for. */
export type GapTag = 'Reading' | 'Listening' | 'Writing';

/**
 * Prefer a writing prompt (or, since Wave 2, a `generated_stories` reading
 * candidate) whose `proficiency_level` band matches the caller's estimate
 * (0–6 scale). The writing bank starts at L3, so 'basic' is never targeted.
 * Null → no band preference.
 *   < 3.5 → L3
 *   < 5   → L4
 *   ≥ 5   → L5+
 */
export function estimateToProficiency(
  estimate: number | null,
): Exclude<Proficiency, 'basic'> | null {
  if (estimate === null || Number.isNaN(estimate)) return null;
  if (estimate < 3.5) return 'L3';
  if (estimate < 5) return 'L4';
  return 'L5+';
}

/**
 * Estimate reading minutes from a character count (Wave 2 — reading_chapters
 * and generated_stories carry no duration metadata, and unlike the old
 * TTMIK-sourced pick, neither carries a sentence count either — a chapter's
 * length lives in its `reading_passages.body` text, a story's in
 * `body_ko`). Models a study pace of ~120 Korean characters/minute for a
 * learner (read + occasional tap-to-define + re-read), clamped to the same
 * [2, 12] tile range the old sentence-based estimate used.
 */
export function readingMinsFromChars(charCount: number): number {
  const CHARS_PER_MINUTE = 120;
  const mins = Math.round(charCount / CHARS_PER_MINUTE);
  return Math.min(12, Math.max(2, mins));
}

/**
 * Map a reading candidate's `proficiency_level` (generated_stories.level, or
 * null for a reading_chapters row — chapters carry no level at all) to the
 * TOPIK-aligned label the design shows. 'L3'/'L5+' pass through; 'L4',
 * 'basic'/'L1'/'L2' (bands the story bank rarely if ever targets), and null
 * (a chapter) all default to 'L4', the design's centre band — the same
 * "no signal → centre band" default the old TTMIK-sourced pick used.
 */
export function readingLevelToLabel(
  level: 'basic' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5+' | null,
): LevelLabel {
  if (level === 'L5+') return 'L5+';
  if (level === 'L3') return 'L3';
  return 'L4';
}

/**
 * Estimate listening minutes from an episode's sentence count. Audio runs
 * slower than silent reading, so we model ~15s per spoken line.
 */
export function listeningMinsFromSentences(sentenceCount: number): number {
  const PACE_SECONDS_PER_SENTENCE = 15;
  const mins = Math.round((sentenceCount * PACE_SECONDS_PER_SENTENCE) / 60);
  return Math.min(15, Math.max(3, mins));
}

/**
 * Pick the weakest of the three surfaced modalities. Returns null when none of
 * the three estimates is present (no snapshot, or only other dimensions run).
 * Ties resolve in the order reading → listening → writing (stable, arbitrary).
 */
export function computeLargestGap(estimates: {
  reading: number | null;
  listening: number | null;
  writing: number | null;
}): GapTag | null {
  const candidates: Array<{ tag: GapTag; value: number }> = [];
  if (estimates.reading !== null) candidates.push({ tag: 'Reading', value: estimates.reading });
  if (estimates.listening !== null) candidates.push({ tag: 'Listening', value: estimates.listening });
  if (estimates.writing !== null) candidates.push({ tag: 'Writing', value: estimates.writing });
  if (candidates.length === 0) return null;
  return candidates.reduce((min, c) => (c.value < min.value ? c : min)).tag;
}

/** Parse a Postgres NUMERIC (returned as string) into a number, null-safe. */
function parseEstimate(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isNaN(n) ? null : n;
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

interface TodayTask {
  title: string;
  mins: number;
  level: LevelLabel;
  tag: GapTag;
  // ── Wave 2 deep-link fields (TODAY_NAV_SCOPING.md B4/B5/B6) — each is
  // populated only for the task whose `tag` names it; additive/optional so
  // the shape stays backward-compatible with any client still on the old
  // envelope.
  /** Reading only: which reading feature this task came from. */
  sourceKind?: 'chapter' | 'story';
  /** Reading only, when `sourceKind === 'chapter'`: reading_chapters.id. */
  chapterId?: number;
  /** Reading only, when `sourceKind === 'story'`: generated_stories.id. */
  storyId?: number;
  /** Listening only: the corpus this episode belongs to. */
  corpus?: 'iyagi';
  /** Listening only: iyagi_episodes.episode_number (the player's natural
   *  key — distinct from the internal DB id). */
  episodeNumber?: number;
  /** Writing only: writing_prompts.id. */
  promptId?: number;
  /** Writing only (F-134): the full Korean prompt body of the advertised
   *  bank row, so the Today tile can PREVIEW the real prompt text (not just
   *  its short `title` label) before the user opens `/learn/writing
   *  ?promptId=<id>`. Same row as `promptId` — the tile shows exactly what
   *  the Writing screen will serve. */
  promptKr?: string;
}

router.get('/today', cheapLimiter(), async (req, res, next) => {
  try {
    const userId = getUserId(req);

    // 1. FSRS due count — live, non-suspended, non-deleted cards due now.
    //    Hanja cards (050) are EXCLUDED to match what the Review screen can
    //    actually drain: /vocab/cards/due filters them out (vocab.ts) and no
    //    client consumes /hanja/cards/due yet, so counting them here would
    //    show phantom workload the user cannot clear. Re-include (or report
    //    the split) when the hanja review UI ships (F-075 client wiring).
    const due = await query<{ due_count: number }>(
      `SELECT count(*)::int AS due_count
         FROM vocab_cards
        WHERE user_id = $1
          AND due_at <= now()
          AND suspended_at IS NULL
          AND deleted_at IS NULL
          AND hanja_character_id IS NULL`,
      [userId],
    );
    const dueCount = due.rows[0]?.due_count ?? 0;

    // 2. Latest diagnostic snapshot — drives band preference + largestGap.
    //    NB: a snapshot existing does NOT guarantee leveled content. If all
    //    three modality estimates are NULL (e.g. a run that exercised only
    //    grammar/vocab), every band param degrades to NULL and selection falls
    //    back to pure deterministic-random — same as having no snapshot at all.
    const snap = await query<{
      reading_estimate: string | null;
      listening_estimate: string | null;
      writing_estimate: string | null;
    }>(
      `SELECT reading_estimate, listening_estimate, writing_estimate
         FROM diagnostic_snapshots
        WHERE user_id = $1 AND deleted_at IS NULL
        ORDER BY captured_at DESC
        LIMIT 1`,
      [userId],
    );
    const readingEstimate = parseEstimate(snap.rows[0]?.reading_estimate ?? null);
    const listeningEstimate = parseEstimate(snap.rows[0]?.listening_estimate ?? null);
    const writingEstimate = parseEstimate(snap.rows[0]?.writing_estimate ?? null);

    const userKey = String(userId);

    // 3. Reading — one of THIS user's own reading_chapters (uploaded-book
    //    chapters) or generated_stories, band-preferred + deterministic per
    //    day (Wave 2 re-source, TODAY_NAV_SCOPING.md B4 Option 2 — replaces
    //    the old ttmik_lessons pick, which had no relationship to the
    //    /learn/reading page's actual content model). BOTH source tables are
    //    user-owned, so every leg of the UNION is scoped `WHERE user_id =
    //    $1` — an empty personal library (no uploads, no generated stories)
    //    yields `reading: null`, the same honest empty-corpus contract the
    //    old pick used. `reading_chapters` carries no proficiency band at
    //    all, so it is always a fallback-tier candidate in the CASE below;
    //    only a `generated_stories` row can win the band-match tier.
    const readingBand = estimateToProficiency(readingEstimate);
    const reading = await query<{
      source_kind: 'chapter' | 'story';
      row_id: string;
      title: string | null;
      chapter_number: number | null;
      level: 'basic' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5+' | null;
      char_count: string;
    }>(
      `WITH candidates AS (
         ${readingCandidatesUnionSql('$1')}
       )
       SELECT candidates.source_kind,
              candidates.row_id::text AS row_id,
              candidates.title,
              candidates.chapter_number,
              candidates.level,
              candidates.char_count::text AS char_count
         FROM candidates
        ORDER BY (CASE WHEN $3::text IS NOT NULL
                        AND candidates.level = $3::text THEN 0 ELSE 1 END),
                 md5($2::text || ${PLAN_DATE_SQL} || candidates.source_kind || candidates.row_id::text)
        LIMIT 1`,
      [userId, userKey, readingBand],
    );
    const readingRow = reading.rows[0];
    const readingTask: TodayTask | null = readingRow
      ? {
          title:
            readingRow.title ??
            (readingRow.source_kind === 'chapter'
              ? `Chapter ${String(readingRow.chapter_number ?? 1)}`
              : 'Reading'),
          mins: readingMinsFromChars(Number(readingRow.char_count)),
          level: readingLevelToLabel(readingRow.level),
          tag: 'Reading',
          sourceKind: readingRow.source_kind,
          ...(readingRow.source_kind === 'chapter'
            ? { chapterId: Number(readingRow.row_id) }
            : { storyId: Number(readingRow.row_id) }),
        }
      : null;

    // 4. Listening — one Iyagi episode. Iyagi carries no per-episode level, so
    //    the label is the fixed 'L3→L4' band (Iyagi targets intermediate
    //    listeners) and selection is pure deterministic-per-day.
    //    Wave 2 (B5): also select `episode_number` — the natural key
    //    Ttmik.tsx/ttmik.ts addresses an episode by (distinct from the
    //    internal `e.id` used only for the per-day hash) — so the Today tile
    //    can deep-link to `?corpus=iyagi&episode=<episodeNumber>` instead of
    //    the bare listening landing page.
    const listening = await query<{
      title: string | null;
      episode_number: number;
      sentence_count: number;
    }>(
      `SELECT e.title,
              e.episode_number,
              (SELECT count(*)::int
                 FROM iyagi_sentences s
                WHERE s.episode_id = e.id) AS sentence_count
         FROM iyagi_episodes e
        ORDER BY md5($1::text || ${PLAN_DATE_SQL} || e.id::text)
        LIMIT 1`,
      [userKey],
    );
    const listeningTask: TodayTask | null = listening.rows[0]
      ? {
          title: listening.rows[0].title ?? 'Iyagi episode',
          mins: listeningMinsFromSentences(listening.rows[0].sentence_count),
          level: 'L3→L4',
          tag: 'Listening',
          corpus: 'iyagi',
          episodeNumber: listening.rows[0].episode_number,
        }
      : null;

    // 5. Writing — one active prompt, band-preferred + deterministic per day.
    // `rubric IS NOT NULL` mirrors GET /writing/prompts (writing.ts): the tile
    // must only advertise a prompt the Writing screen can actually serve
    // (F-014). Migration 038 retired every rubric-NULL row by data, but an
    // operator re-activating a legacy row must not reopen the tile-vs-screen
    // mismatch — the invariant is enforced structurally in BOTH queries.
    const writingBand = estimateToProficiency(writingEstimate);
    const writing = await query<{
      id: string;
      title: string;
      prompt_kr: string;
      level: Proficiency;
      est_minutes: number;
    }>(
      `SELECT id::text AS id, title, prompt_kr, level::text AS level, est_minutes
         FROM writing_prompts
        WHERE is_active
          AND rubric IS NOT NULL
        ORDER BY (CASE WHEN $2::proficiency_level IS NOT NULL
                        AND level = $2::proficiency_level THEN 0 ELSE 1 END),
                 md5($1::text || ${PLAN_DATE_SQL} || id::text)
        LIMIT 1`,
      [userKey, writingBand],
    );
    const writingRow = writing.rows[0];
    const writingTask: TodayTask | null = writingRow
      ? {
          title: writingRow.title,
          mins: writingRow.est_minutes,
          // writing_prompts.level is L3/L4/L5+ (never 'basic' in the bank);
          // narrow to the label union with an L4 fallback for safety.
          level:
            writingRow.level === 'L3' ||
            writingRow.level === 'L4' ||
            writingRow.level === 'L5+'
              ? writingRow.level
              : 'L4',
          tag: 'Writing',
          // Wave 2 (B6): the exact bank row, so Today's Writing tile can
          // request THIS prompt by id instead of a fresh random draw.
          promptId: Number(writingRow.id),
          // F-134: the full prompt body of that SAME row — the tile previews
          // the real text the Writing screen will serve for this promptId.
          promptKr: writingRow.prompt_kr,
        }
      : null;

    const largestGap = computeLargestGap({
      reading: readingEstimate,
      listening: listeningEstimate,
      writing: writingEstimate,
    });

    // 6. F-212 P4 — evidence-driven "best next exercise" (ADDITIVE field).
    //    The Phase-2 continuous estimator (NOT the diagnostic snapshot above —
    //    the two surfaces stay separate; the snapshot keeps owning band
    //    preference + largestGap) picks the dimension + item to do next; see
    //    services/ability/recommend.ts for the locked two-stage scoring.
    //
    //    persist:false — /plan/today is documented as a PURE READ (see the
    //    module note + THREAT MODEL); the estimator's daily user_progress
    //    sample stays exclusive to GET /ability/estimate.
    //
    //    Best-effort: the block is additive UX, so a recommender failure logs
    //    and degrades to `recommendation: null` (the client keeps its
    //    existing deterministic tiles) rather than failing the whole plan.
    let recommendation: Recommendation | null = null;
    let alternatives: Recommendation[] = [];
    try {
      const abilityEstimates = await estimateAbility(userId, { persist: false });

      // Per-dimension due split — the SAME predicate as the dueCount query in
      // step 1 (live, due, non-suspended, non-deleted, non-hanja), partitioned
      // by card kind: a grammar PRODUCTION card (grammar_entry_id IS NOT NULL)
      // feeds the grammar dimension, everything else the vocab dimension —
      // so vocabDue + grammarDue always reconciles with dueCount above.
      const dueSplit = await query<{ kind: 'grammar' | 'vocab'; n: number }>(
        `SELECT CASE WHEN grammar_entry_id IS NOT NULL
                     THEN 'grammar' ELSE 'vocab' END AS kind,
                count(*)::int AS n
           FROM vocab_cards
          WHERE user_id = $1
            AND due_at <= now()
            AND suspended_at IS NULL
            AND deleted_at IS NULL
            AND hanja_character_id IS NULL
          GROUP BY 1`,
        [userId],
      );
      const dueByKind = { vocab: 0, grammar: 0 };
      for (const row of dueSplit.rows) dueByKind[row.kind] = row.n;

      // estimateAbility without includeWriting returns exactly the four
      // recommendable dimensions (writing HELD in v1 — the locked decision).
      const dimensions: DimensionSignal[] = abilityEstimates
        .filter((e): e is typeof e & { dimension: RecommendDimension } =>
          e.dimension !== 'writing')
        .map((e) => ({
          dimension: e.dimension,
          theta: e.theta,
          se: e.se,
          insufficient: e.insufficient,
          dueCount:
            e.dimension === 'vocab'
              ? dueByKind.vocab
              : e.dimension === 'grammar'
                ? dueByKind.grammar
                : 0,
        }));

      // Cold start (no dimension has enough evidence) → null, and skip the
      // candidate queries entirely — there is nothing to rank against.
      if (!dimensions.every((d) => d.insufficient)) {
        // The Seoul plan date — the SAME rollover boundary every selection
        // hash above pins — seeds the recommender's deterministic tie-breaks.
        const dayRow = await query<{ d: string }>(`SELECT ${PLAN_DATE_SQL} AS d`);
        const dayKey = dayRow.rows[0]!.d;

        const targets = Object.fromEntries(
          dimensions.map((d) => [
            d.dimension,
            targetDifficulty(d.insufficient ? null : d.theta),
          ]),
        ) as Record<RecommendDimension, number>;
        const candidates = await fetchCandidates(userId, targets);
        const ranked = rankRecommendations({
          userKey,
          dayKey,
          dimensions,
          candidates,
        });
        recommendation = ranked.recommendation;
        alternatives = ranked.alternatives;
      }
    } catch (err) {
      getLogger().warn(
        {
          userId,
          err: { name: (err as Error).name, message: (err as Error).message },
        },
        'plan: next-exercise recommendation failed (plan still served)',
      );
    }

    res.status(200).json({
      dueCount,
      reading: readingTask,
      listening: listeningTask,
      writing: writingTask,
      largestGap,
      // F-212 P4 (additive): null on cold start / recommender failure — the
      // client falls back to the existing deterministic tiles.
      recommendation,
      ...(recommendation !== null ? { alternatives } : {}),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
