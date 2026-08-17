/**
 * Per-dimension candidate generators (F-212 Phase 4) — the I/O half of the
 * next-exercise recommender. Each generator REUSES an existing, proven query
 * (or its extracted shared form) rather than inventing a parallel content
 * model, and returns `CandidateItem`s the pure ranker (recommend.ts) scores:
 *
 *   reading   — the `reading_chapters ∪ generated_stories` UNION plan.ts's
 *               Wave-2 pick selects from (`readingCandidatesUnionSql`, the
 *               shared helper extracted from that route). Stories carry
 *               b = proficiencyToNumber(level); chapters have no band → null.
 *   listening — the plan.ts Iyagi pick's query shape. Iyagi carries no
 *               per-episode level → all b = null (the ranker's NEUTRAL_PROX).
 *   vocab     — DUE-FIRST: the `/vocab/cards/due` predicate (due, live,
 *               non-suspended, non-hanja), restricted to non-grammar cards
 *               (grammar production cards belong to the grammar dimension);
 *               when nothing is due, fall back to the live vocab deck,
 *               band-matched to the target difficulty.
 *   grammar   — due grammar PRODUCTION cards first (same due predicate,
 *               `grammar_entry_id IS NOT NULL`, graduated patterns excluded —
 *               mirroring /vocab/cards/due); else the user's banked
 *               grammar_entries (the GET /grammar/bank read), band-matched.
 *
 * Band fallbacks degrade gracefully: when the strict band-match returns
 * nothing but the user DOES have content, the query re-runs unbanded — a
 * dimension with real material is never reported empty-handed just because
 * no row sits in the target band (the ranker's proximity scoring handles the
 * off-band difficulty honestly).
 *
 * Determinism: fallback pools order by the SAME md5(user‖Seoul-day‖id) idiom
 * as every plan.ts selection, so the candidate WINDOW (top-K) is stable per
 * (user, day); due pools order by due_at (oldest first — the review queue's
 * own order). The pure ranker then applies exact proximity + md5 tie-breaks.
 *
 * SECURITY (tenant isolation): `userId` is SERVER-BOUND — the route passes
 * the session user, never a client-supplied id. Every user-owned read is
 * `WHERE user_id = $1`-scoped; iyagi_episodes is public corpus data (same
 * posture as the plan.ts listening pick). All SQL is parameterized; the only
 * interpolations are trusted server-side literals (the Seoul-date expression
 * and the shared UNION fragment).
 *
 * NOTE on the import from routes/plan.js: the shared UNION + the pure
 * mins/level/band helpers have exactly one home (plan.ts, where the Today
 * tiles are composed) and are deliberately REUSED here, not duplicated, so
 * tile and recommendation can never disagree about pacing or banding. This
 * forms a benign module cycle (plan.ts → candidates.ts → plan.ts): every
 * cross-module use on both sides happens at CALL time inside request-scoped
 * functions — never at module init — so CJS resolves it safely.
 */

import { query } from '../../db/pool.js';
import { proficiencyToNumber, type ProficiencyLevel } from './anchors.js';
import {
  estimateToProficiency,
  listeningMinsFromSentences,
  planDateSql,
  readingCandidatesUnionSql,
  readingLevelToLabel,
  readingMinsFromChars,
} from '../../routes/plan.js';
import type { CandidateItem, RecommendDimension } from './recommend.js';

/** Candidate window per dimension — the ranker scores exact proximity inside
 *  this deterministic top-K, so K only matters for corpora larger than it. */
const CANDIDATE_LIMIT = 25;

/** v1 coarse per-item time estimates for the card-based dimensions (a review
 *  or drill sitting, not a single flash) — the reading/listening dimensions
 *  derive real char/sentence-based minutes instead. */
const VOCAB_REVIEW_MINS = 5;
const GRAMMAR_DRILL_MINS = 5;

/** Target difficulty b* per dimension (recommend.ts `targetDifficulty`). */
export type CandidateTargets = Record<RecommendDimension, number>;

export type DimensionCandidates = Record<RecommendDimension, CandidateItem[]>;

/** The narrow proficiency union the content tables actually store. */
type ContentLevel = 'basic' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5+';

/**
 * Fetch every dimension's candidate pool for one user. Empty pools are
 * returned as empty arrays (the ranker skips those dimensions).
 */
export async function fetchCandidates(
  userId: number,
  targets: CandidateTargets,
): Promise<DimensionCandidates> {
  const userKey = String(userId);
  return {
    reading: await readingCandidates(userId, userKey, targets.reading),
    listening: await listeningCandidates(userKey),
    vocab: await vocabCandidates(userId, userKey, targets.vocab),
    grammar: await grammarCandidates(userId, userKey, targets.grammar),
  };
}

/**
 * Reading — top-K from the shared plan.ts UNION, band-preferred toward the
 * target difficulty (the same CASE idiom as the Wave-2 pick) + deterministic
 * md5 order. Stories are placed (b from their level); chapters are not.
 */
async function readingCandidates(
  userId: number,
  userKey: string,
  bStar: number,
): Promise<CandidateItem[]> {
  const band = estimateToProficiency(bStar);
  const { rows } = await query<{
    source_kind: 'chapter' | 'story';
    row_id: string;
    title: string | null;
    chapter_number: number | null;
    level: ContentLevel | null;
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
               md5($2::text || ${planDateSql()} || candidates.source_kind || candidates.row_id::text)
      LIMIT $4`,
    [userId, userKey, band, CANDIDATE_LIMIT],
  );
  return rows.map((row) => {
    const id = Number(row.row_id);
    const isChapter = row.source_kind === 'chapter';
    return {
      itemKey: `reading:${row.source_kind}:${String(id)}`,
      // Only a story carries a difficulty band; a chapter is unplaced (null b
      // → the ranker's NEUTRAL_PROX), exactly like the Wave-2 pick's tiering.
      b: !isChapter && row.level !== null ? proficiencyToNumber(row.level) : null,
      deepLink: isChapter
        ? `/learn/reading?chapter=${String(id)}`
        : `/learn/reading?story=${String(id)}`,
      level: readingLevelToLabel(row.level),
      title:
        row.title ??
        (isChapter ? `Chapter ${String(row.chapter_number ?? 1)}` : 'Reading'),
      mins: readingMinsFromChars(Number(row.char_count)),
      sourceKind: row.source_kind,
      ...(isChapter ? { chapterId: id } : { storyId: id }),
    };
  });
}

/**
 * Listening — top-K Iyagi episodes in deterministic md5 order (the plan.ts
 * listening pick's shape). No per-episode level exists → every b is null.
 */
async function listeningCandidates(userKey: string): Promise<CandidateItem[]> {
  const { rows } = await query<{
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
      ORDER BY md5($1::text || ${planDateSql()} || e.id::text)
      LIMIT $2`,
    [userKey, CANDIDATE_LIMIT],
  );
  return rows.map((row) => ({
    itemKey: `listening:iyagi:${String(row.episode_number)}`,
    b: null,
    deepLink: `/learn/listen?corpus=iyagi&episode=${String(row.episode_number)}`,
    level: 'L3→L4',
    title: row.title ?? 'Iyagi episode',
    mins: listeningMinsFromSentences(row.sentence_count),
    corpus: 'iyagi' as const,
    episodeNumber: row.episode_number,
  }));
}

/**
 * Vocab — due cards first (oldest due leads, the review queue's own order),
 * restricted to the vocab deck (non-grammar, non-hanja — each of those has
 * its own dimension/queue). Nothing due → the live deck, band-preferred.
 *
 * b comes from the backing vocab_entries.proficiency; a card without one
 * (sentence-/topik-target cards riding the same deck) stays unplaced.
 */
async function vocabCandidates(
  userId: number,
  userKey: string,
  bStar: number,
): Promise<CandidateItem[]> {
  const due = await query<{
    id: string;
    korean: string | null;
    proficiency: ContentLevel | null;
  }>(
    `SELECT c.id::text AS id, ve.korean, ve.proficiency::text AS proficiency
       FROM vocab_cards c
       LEFT JOIN vocab_entries ve ON ve.id = c.vocab_entry_id
      WHERE c.user_id = $1
        AND c.due_at <= now()
        AND c.suspended_at IS NULL
        AND c.deleted_at IS NULL
        AND c.hanja_character_id IS NULL
        AND c.grammar_entry_id IS NULL
      ORDER BY c.due_at, c.id
      LIMIT $2`,
    [userId, CANDIDATE_LIMIT],
  );
  const rows = due.rows.length > 0 ? due.rows : await vocabDeckFallback(userId, userKey, bStar);
  return rows.map((row) => ({
    itemKey: `vocab:card:${row.id}`,
    b: row.proficiency !== null ? proficiencyToNumber(row.proficiency) : null,
    deepLink: '/learn/vocab',
    level: readingLevelToLabel(row.proficiency),
    title: row.korean ?? 'Vocabulary review',
    mins: VOCAB_REVIEW_MINS,
  }));
}

/** The not-due vocab fallback: live deck cards, band-matched to b*, unbanded
 *  retry when the band is empty (see module note on graceful degrade). */
async function vocabDeckFallback(
  userId: number,
  userKey: string,
  bStar: number,
): Promise<Array<{ id: string; korean: string | null; proficiency: ContentLevel | null }>> {
  const run = async (band: ProficiencyLevel | null) =>
    query<{ id: string; korean: string | null; proficiency: ContentLevel | null }>(
      `SELECT c.id::text AS id, ve.korean, ve.proficiency::text AS proficiency
         FROM vocab_cards c
         JOIN vocab_entries ve ON ve.id = c.vocab_entry_id
        WHERE c.user_id = $1
          AND c.suspended_at IS NULL
          AND c.deleted_at IS NULL
          AND c.hanja_character_id IS NULL
          AND c.grammar_entry_id IS NULL
          AND ($3::proficiency_level IS NULL OR ve.proficiency = $3::proficiency_level)
        ORDER BY md5($2::text || ${planDateSql()} || c.id::text)
        LIMIT $4`,
      [userId, userKey, band, CANDIDATE_LIMIT],
    );
  const banded = await run(estimateToProficiency(bStar));
  if (banded.rows.length > 0) return banded.rows;
  return (await run(null)).rows;
}

/**
 * Grammar — due grammar PRODUCTION cards first (same due predicate as the
 * review queue, graduated patterns excluded exactly as /vocab/cards/due
 * excludes them); else the user's banked, non-graduated grammar_entries
 * (the GET /grammar/bank read), band-preferred with unbanded retry.
 */
async function grammarCandidates(
  userId: number,
  userKey: string,
  bStar: number,
): Promise<CandidateItem[]> {
  const due = await query<{
    key: string;
    pattern_display: string;
    proficiency: ContentLevel;
  }>(
    `SELECT 'card:' || c.id::text AS key,
            ge.pattern_display,
            ge.proficiency::text AS proficiency
       FROM vocab_cards c
       JOIN grammar_entries ge
         ON ge.id = c.grammar_entry_id
        AND ge.user_id = c.user_id
        AND ge.deleted_at IS NULL
      WHERE c.user_id = $1
        AND c.due_at <= now()
        AND c.suspended_at IS NULL
        AND c.deleted_at IS NULL
        AND c.hanja_character_id IS NULL
        AND c.grammar_entry_id IS NOT NULL
        AND ge.graduated_at IS NULL
      ORDER BY c.due_at, c.id
      LIMIT $2`,
    [userId, CANDIDATE_LIMIT],
  );
  const rows = due.rows.length > 0 ? due.rows : await grammarBankFallback(userId, userKey, bStar);
  return rows.map((row) => ({
    itemKey: `grammar:${row.key}`,
    b: proficiencyToNumber(row.proficiency),
    deepLink: '/learn/grammar',
    level: readingLevelToLabel(row.proficiency),
    title: row.pattern_display,
    mins: GRAMMAR_DRILL_MINS,
  }));
}

/** The not-due grammar fallback: banked active patterns, band-matched to b*,
 *  unbanded retry when the band is empty. */
async function grammarBankFallback(
  userId: number,
  userKey: string,
  bStar: number,
): Promise<Array<{ key: string; pattern_display: string; proficiency: ContentLevel }>> {
  const run = async (band: ProficiencyLevel | null) =>
    query<{ key: string; pattern_display: string; proficiency: ContentLevel }>(
      `SELECT 'entry:' || g.id::text AS key,
              g.pattern_display,
              g.proficiency::text AS proficiency
         FROM grammar_entries g
        WHERE g.user_id = $1
          AND g.deleted_at IS NULL
          AND g.graduated_at IS NULL
          AND ($3::proficiency_level IS NULL OR g.proficiency = $3::proficiency_level)
        ORDER BY md5($2::text || ${planDateSql()} || g.id::text)
        LIMIT $4`,
      [userId, userKey, band, CANDIDATE_LIMIT],
    );
  const banded = await run(estimateToProficiency(bStar));
  if (banded.rows.length > 0) return banded.rows;
  return (await run(null)).rows;
}
