/**
 * Diagnostic screen fixtures + loaders.
 *
 * `DiagnosticSnapshot` — drives the Results screen + Today's SkillsCompare, and
 * is the mock-fallback for `GET /diagnostic/latest`.
 *
 * Pass 5 retired the old whole-test bundle (`DiagnosticTest` / the test loader):
 * the Taking flow is now server-graded item-by-item (`POST /diagnostic`,
 * `POST /diagnostic/:runId/answer`), which is a live mutation flow with no mock
 * fallback. Only the snapshot loader remains as a fallback for the realFn.
 */
import type { DiagnosticSnapshot } from '../../types/domain';
import { mockDelay } from './_delay';

/**
 * Default snapshot — **empty** dimensions list represents "no prior run."
 *
 * Diagnostic uses this signal to decide whether to default the user to
 * the Intro screen (no prior run) vs the Results screen (showing the last
 * snapshot). A populated snapshot is reachable via the rich fixture
 * `DIAGNOSTIC_SNAPSHOT_POPULATED_FIXTURE` below; tests + a future
 * "I just completed a test" path can swap to it. The exit-criterion-1
 * requirement for Pass 2 is: fresh boot lands on Intro.
 */
export const DIAGNOSTIC_SNAPSHOT_FIXTURE: DiagnosticSnapshot = {
  dimensions: [],
  references: [
    { id: 'L3', label: 'TOPIK 3', kr: '3급', value: 40 },
    { id: 'L4', label: 'TOPIK 4', kr: '4급', value: 55 },
    { id: 'L5', label: 'TOPIK 5', kr: '5급', value: 70 },
    { id: 'L6', label: 'TOPIK 6', kr: '6급', value: 85 },
    { id: 'native', label: 'Native', kr: '원어민', value: 100 },
  ],
  defaultRef: 'L4',
  goals: [],
};

/**
 * Populated snapshot — used by tests and by the post-test flow when a
 * real run lands. Mirrors the original `DIAGNOSTIC` fixture from
 * `data.js` (plus a grammar dimension for Pass 5 parity) so visual parity
 * with the design HTML is preserved when Results renders.
 */
export const DIAGNOSTIC_SNAPSHOT_POPULATED_FIXTURE: DiagnosticSnapshot = {
  // F-011: each dimension carries a confidence band (scoreLow ≤ score ≤
  // scoreHigh) so mock mode exercises the band rendering. `writing` keeps a
  // degenerate band (low == score == high) to exercise the honest "no band"
  // fallback the server sends when a dimension has no usable stats.
  dimensions: [
    {
      key: 'reading',
      label: 'Reading',
      kr: '읽기',
      score: 62,
      scoreLow: 54,
      scoreHigh: 70,
      note: 'Paragraph inference solid. Push academic register.',
    },
    {
      key: 'listening',
      label: 'Listening',
      kr: '듣기',
      score: 44,
      scoreLow: 34,
      scoreHigh: 54,
      note: 'News pace + interview clips are the gap.',
    },
    {
      key: 'writing',
      label: 'Writing',
      kr: '쓰기',
      score: 38,
      scoreLow: 38,
      scoreHigh: 38,
      note: 'Register too casual for 합쇼체.',
    },
    {
      key: 'vocab',
      label: 'Vocabulary',
      kr: '어휘',
      score: 51,
      scoreLow: 43,
      scoreHigh: 59,
      note: 'Thin academic coverage (정책, 발전, 영향).',
    },
    {
      key: 'grammar',
      label: 'Grammar',
      kr: '문법',
      score: 47,
      scoreLow: 36,
      scoreHigh: 58,
      note: 'Connectives (-더라도, -느라고) inconsistent under time.',
    },
  ],
  references: [
    { id: 'L3', label: 'TOPIK 3', kr: '3급', value: 40 },
    { id: 'L4', label: 'TOPIK 4', kr: '4급', value: 55 },
    { id: 'L5', label: 'TOPIK 5', kr: '5급', value: 70 },
    { id: 'L6', label: 'TOPIK 6', kr: '6급', value: 85 },
    { id: 'native', label: 'Native', kr: '원어민', value: 100 },
  ],
  defaultRef: 'L4',
  goals: [
    'Drill 더라도 / 느라고 production until automatic.',
    'Build 60 academic-register vocab cards over 3 weeks.',
    'One news listening clip + transcript daily.',
    'Rewrite one paragraph in 합쇼체 weekly.',
  ],
};

/** Skills snapshot loader — drives SkillsCompare on Today + Results. */
export async function loadDiagnosticSnapshotMock(): Promise<DiagnosticSnapshot> {
  await mockDelay();
  return DIAGNOSTIC_SNAPSHOT_FIXTURE;
}
