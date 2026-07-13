/**
 * Progress — the stats hub (Overhaul P1.2, Slice A; reskinned + reworked
 * for Wave-2 "Seoul, Day & Night" — F-128/F-129/F-141/F-142/F-143).
 *
 * Three top-level sections, each a `CollapsibleTile` (F-141) so the page
 * reads as a foldable stack instead of three permanently-stacked cards. The
 * TOPIK-compare section is the one exception the ticket calls out by name —
 * it defaults OPEN; the other two default collapsed:
 *
 *   1. **TOPIK compare** (`defaultCollapsed={false}`) — `SkillsCompare`
 *      (variant `full`) over the LATEST diagnostic attempt under its own
 *      "Where you stand" headline, with the TOPIK-1→Native reference picker,
 *      a **Retake diagnostic** button, a `SubwayProgress` read of how many
 *      attempts the user has banked so far (device #5), a milestone
 *      `SealStamp` when the latest attempt is a new personal best (device
 *      #7), and the **attempt history carousel** (F-030): a looping
 *      `SwipeCarousel` (F-029) of (a) **Trend** — the inline-SVG line chart
 *      of diagnostic scores across attempts, now with a dashed least-squares
 *      trend line over the derived Overall series and an emphasized marker
 *      on each series' latest point (F-142), (b) **Attempt vs attempt** —
 *      two pickers + a signed delta table (≥ 2 attempts only), and
 *      (c) **All attempts** — the chart's accessible twin table.
 *   2. **Progress by skill** (F-017, moved from Today; `defaultCollapsed`) —
 *      a `SwipeCarousel` of five `SkillTrendPanel` pages (Reading /
 *      Listening / Vocab / Grammar / Writing), each a `LineChart` of that
 *      skill's 30-day series. Independent of the diagnostic history — it
 *      renders (or errors) on its own fetch, so a user with practice
 *      activity but no diagnostic still sees their trends.
 *   3. **Mastery** (F-032; `defaultCollapsed`) — ONE tabbed area (`Tabs`
 *      primitive) with three panels sharing the same space instead of
 *      stacked cards: Words (F-013, per-word FSRS buckets, F-031 windowed
 *      list), Grammar (a designed "coming soon" placeholder — the real
 *      route lands in P4), Hanja (F-041, the aggregate banked/practicing/new
 *      bands + Encountered-vs-L4 from `GET /hanja/progress`).
 *
 * `CollapsibleTile` keeps a collapsed section's body MOUNTED (aria-hidden +
 * inert, not unmounted) — every fetch below still fires on page load
 * regardless of which sections start folded; collapsing only affects what a
 * screen reader/keyboard user can currently reach, never data freshness.
 *
 * F-128 reskin: the page opens with a `SkylineHeader` (device #4) carrying
 * the real `<h1>`, a `DancheongRail` accent underneath (device #2), a
 * `.km-giwa`/`.km-hangul-watermark` texture on the empty state (devices
 * #3/#6), a `.km-rain-sheen` ambient overlay on the page root (device #8,
 * Night-only per its own CSS gate), and `.km-najeon` on the milestone seal
 * (device #9, sparingly). `CityCard` is NOT used here: `CollapsibleTile`
 * (mandatory for F-141) hardcodes the plain `Card` surface internally, and
 * `CollapsibleTile.tsx` is a shared component maintained outside this page —
 * swapping its wrapper to `CityCard` would require changing that shared
 * file, so it was deliberately left as `Card` rather than touched here.
 *
 * F-143 ("remove 'begin today's plan' + 'gaps/next steps' blocks") found no
 * such blocks anywhere on THIS page — that copy lives on `Diagnostic.tsx`'s
 * results screen, not Progress. Nothing here needed removing; a regression
 * test below pins that these strings never appear on Progress.
 *
 * Data:
 *   useEndpointOrMock('diagnostic.history', …, { realFn: getHistory })       → DiagnosticHistoryResponse
 *   useEndpointOrMock('progress.series', …, { realFn: fetchSkillSeries })    → AllSkillSeries (F-017)
 *   fetchMastery (direct, abortable)                                         → MasteryPage (F-013/F-031)
 *   fetchHanjaProgress (direct, abortable)                                   → HanjaProgress (F-041)
 *
 * The series fan-out degrades per skill (`fetchSkillSeries` never rejects on
 * a route failure — a failed skill becomes an honest "Couldn't load this
 * trend." panel, never fixture numbers). When EVERY route failed (total
 * outage) the whole card collapses to a single ErrorCard with a retry
 * (F-UP-016a) — a failure is never dressed up as five fresh-account
 * "No data yet" panels.
 *
 * Empty states: 0 snapshots → invitation card linking to /diagnostic;
 * 1 snapshot → markers only (a one-point "trend" draws no line) + a note,
 * attempt-vs-attempt hidden. Neither crashes — geometry guards `n === 1`.
 *
 * Threat model:
 *   - **Rendered text is escaped.** Every server string (labels, kr, goals,
 *     series units) renders as React children — a malicious payload becomes
 *     literal text. No `dangerouslySetInnerHTML`; SVG text nodes are React
 *     children too.
 *   - **Read-only surface.** The page issues authenticated GETs only; no
 *     mutation, no client-supplied identifiers (no IDOR surface). Server
 *     scopes every query to the session user (including `/hanja/progress`,
 *     whose templated `note` string renders as a React child — escaped).
 *   - **Mock fallback honesty.** The history mock loader resolves an EMPTY
 *     history (mirroring the Diagnostic screen's empty fixture) so a
 *     real-endpoint failure can never paint fabricated progress; when the
 *     real call fails and the fallback is empty we show the error card, not
 *     a fake state. The series source can't trip the mock fallback at all —
 *     its realFn never rejects (per-skill degradation).
 */
import { useEffect, useState, type JSX, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bilingual } from '../components/Bilingual';
import { Button } from '../components/Button';
import { CollapsibleTile } from '../components/CollapsibleTile';
import { DancheongRail } from '../components/DancheongRail';
import { Eyebrow } from '../components/Eyebrow';
import { Icon } from '../components/Icon';
import { MockBadge } from '../components/MockBadge';
import { ErrorCard } from '../components/ErrorCard';
import { LineChart } from '../components/LineChart';
import { Pill } from '../components/Pill';
import { SealStamp } from '../components/SealStamp';
import { ShowMore } from '../components/ShowMore';
import { SkillsCompare } from '../components/SkillsCompare';
import type { SkillReference, SkillRow } from '../components/SkillsCompare';
import { SkylineHeader } from '../components/SkylineHeader';
import { SubwayProgress } from '../components/SubwayProgress';
import { SwipeCarousel } from '../components/SwipeCarousel';
import { Tabs } from '../components/Tabs';
import type { TabItem } from '../components/Tabs';
import { useChatContext } from '../hooks/useChatContext';
import { useEndpointOrMock } from '../hooks/useEndpointOrMock';
import type { UseEndpointOrMockResult } from '../hooks/useEndpointOrMock';
import { usePagination } from '../hooks/usePagination';
import { cn } from '../lib/cn';
import { encounteredBarAria } from '../lib/encounteredBar';
import { navItem } from '../lib/nav';
import { getHistory } from '../services/diagnostic';
import { fetchHanjaProgress } from '../services/hanja';
import { fetchSkillSeries } from '../services/stats';
import { fetchMastery } from '../services/vocab';
import { ApiError } from '../services/api';
import { errorMessageFor } from '../lib/errorCopy';
import { mockDelay } from '../data/mocks/_delay';
import { loadSkillSeriesMock } from '../data/mocks/stats';
import type {
  AllSkillSeries,
  DiagnosticHistoryResponse,
  DiagnosticHistorySnapshot,
  DiagnosticSnapshot,
  HanjaProgress,
  MasteryBucket,
  MasteryPage,
  MasterySummary,
  MasteryWord,
  SkillSeries,
} from '../types/domain';
import './Progress.css';

// ─────────────────────────────────────────────────────────────
// Series manifest + score helpers
// ─────────────────────────────────────────────────────────────

/** Page eyebrow source — nav.ts owns the en/kr pair (P3b Batch A). */
const PROGRESS_NAV = navItem('progress');

type DimensionKey = 'reading' | 'listening' | 'vocab' | 'grammar';
type SeriesKey = DimensionKey | 'overall';

interface SeriesDef {
  readonly key: SeriesKey;
  readonly label: string;
  readonly kr: string;
}

const DIMENSIONS: ReadonlyArray<SeriesDef & { key: DimensionKey }> = [
  { key: 'reading', label: 'Reading', kr: '읽기' },
  { key: 'listening', label: 'Listening', kr: '듣기' },
  { key: 'vocab', label: 'Vocabulary', kr: '어휘' },
  { key: 'grammar', label: 'Grammar', kr: '문법' },
];

/** Overall is a derived aggregate, not a fifth identity — neutral ink line. */
const SERIES: ReadonlyArray<SeriesDef> = [
  ...DIMENSIONS,
  { key: 'overall', label: 'Overall', kr: '전체' },
];

/** Score for one dimension of one attempt, or null when it wasn't scored
 *  (an empty item pool can drop a dimension from a run's snapshot). */
function scoreOf(snap: DiagnosticHistorySnapshot, key: DimensionKey): number | null {
  const dim = snap.dimensions.find((d) => d.key === key);
  return dim ? dim.score : null;
}

/** Overall = rounded mean of the attempt's PRESENT dimensions (client-side
 *  derivation — the server DTO deliberately has no overall field). */
function overallOf(snap: DiagnosticHistorySnapshot): number | null {
  if (snap.dimensions.length === 0) return null;
  const sum = snap.dimensions.reduce((acc, d) => acc + d.score, 0);
  return Math.round(sum / snap.dimensions.length);
}

function seriesScore(snap: DiagnosticHistorySnapshot, key: SeriesKey): number | null {
  return key === 'overall' ? overallOf(snap) : scoreOf(snap, key);
}

/**
 * Short M/D date from the ISO capture timestamp, using UTC parts so the
 * label (and the tests asserting it) is timezone-independent. Day-level
 * drift at midnight boundaries is acceptable for a trend axis label; the
 * table shows the same formatting so chart and table always agree.
 */
function formatDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${String(d.getUTCMonth() + 1)}/${String(d.getUTCDate())}`;
}

// ─────────────────────────────────────────────────────────────
// SkillsCompare mappers (moved from Today with the compare surface)
// ─────────────────────────────────────────────────────────────

/** Map a domain snapshot to the SkillsCompare props shape. Unlike Today's old
 *  compact tile, the `full` variant renders the F-011 confidence band and the
 *  per-bar gap notes, so both pass through here. */
function toSkillRows(snap: DiagnosticSnapshot): ReadonlyArray<SkillRow> {
  return snap.dimensions.map((d) => ({
    key: d.key,
    label: d.label,
    kr: d.kr,
    score: d.score,
    scoreLow: d.scoreLow,
    scoreHigh: d.scoreHigh,
    note: d.note,
  }));
}
function toSkillRefs(snap: DiagnosticSnapshot): ReadonlyArray<SkillReference> {
  return snap.references.map((r) => ({
    id: r.id,
    label: r.label,
    kr: r.kr,
    value: r.value,
    // `native` is the ceiling — design paints its tick indigo, not vermilion.
    isCeiling: r.id === 'native',
  }));
}

// ─────────────────────────────────────────────────────────────
// Progress-by-skill carousel (F-017 — moved from Today in P1.2)
// ─────────────────────────────────────────────────────────────

/**
 * Trend window (days) — the single source for both the fetch and the chart
 * aria-labels, so the labels can never drift from the data window.
 */
const TREND_WINDOW_DAYS = 30;

/** Carousel page order — fixed by the feature spec (F-017). */
const SERIES_PANELS: ReadonlyArray<{
  key: keyof AllSkillSeries;
  label: string;
  kr: string;
}> = [
  { key: 'reading', label: 'Reading', kr: '읽기' },
  { key: 'listening', label: 'Listening', kr: '듣기' },
  { key: 'vocab', label: 'Vocab', kr: '어휘' },
  { key: 'grammar', label: 'Grammar', kr: '문법' },
  { key: 'writing', label: 'Writing', kr: '쓰기' },
];

/** Chart caption per metric — `none` never reaches the chart (placeholder). */
const METRIC_LABELS: Record<SkillSeries['metric'], string> = {
  accuracy: 'Accuracy',
  count: 'Count',
  score: 'Score',
  none: '',
};

/**
 * Latest-value headline for a panel: "74%" for percent series (TOPIK
 * accuracy, Writing's normalized score), "35 reviews" / "52 pts" for the
 * rest, an em dash when the series has no points yet. Keyed on the unit —
 * not the metric — so it matches the LineChart readout's own `%` formatting.
 */
function latestValue(series: SkillSeries): string {
  const last = series.points[series.points.length - 1];
  if (last === undefined) return '—';
  if (series.unit === '%') return `${String(Math.round(last.value))}%`;
  const unitSuffix = series.unit !== '' ? ` ${series.unit}` : '';
  return `${String(last.value)}${unitSuffix}`;
}

/** One carousel page: skill name + latest value + the trend chart. */
function SkillTrendPanel({
  skillKey,
  label,
  kr,
  series,
}: {
  skillKey: keyof AllSkillSeries;
  label: string;
  kr: string;
  series: SkillSeries;
}): JSX.Element {
  return (
    // data-skill drives the per-skill chart accent in Progress.css (the same
    // validated categorical --kmp-* palette the diagnostic trend chart uses,
    // so color follows the entity across the page).
    <div className="km-progress__trendPanel" data-skill={skillKey}>
      <div className="km-progress__trendHead">
        <span className="km-progress__trendSkill">
          <Bilingual en={label} kr={kr} />
        </span>
        <span className="km-progress__trendValue">{latestValue(series)}</span>
      </div>
      {series.metric === 'none' ? (
        // `none` is the client-only degraded placeholder: this skill's route
        // FAILED — say so (F-UP-016a). "No data yet" is reserved for a route
        // that answered with an empty series (LineChart renders that copy
        // itself), so a fetch failure is never dressed up as a fresh account.
        // Never fabricated numbers either way (F-014 gave Writing a real
        // /writing/series route, so it degrades like every other skill now).
        <div className="km-progress__trendEmpty">
          <Bilingual en="Couldn’t load this trend." kr="추이를 불러오지 못했어요." />
        </div>
      ) : skillKey === 'writing' && series.points.length === 0 ? (
        // Writing's route answered but the user has no graded attempts yet —
        // an invitation to start, not a bare empty chart. Only the empty
        // REAL series lands here; a failed route reads "No data yet" above.
        <div className="km-progress__trendEmpty">
          <Bilingual
            en="Start writing to see your progress here."
            kr="성장을 보려면 쓰기를 시작하세요."
          />
        </div>
      ) : (
        <LineChart
          points={series.points}
          unit={series.unit}
          metricLabel={METRIC_LABELS[series.metric]}
          ariaLabel={`${label} trend over the last ${String(TREND_WINDOW_DAYS)} days`}
        />
      )}
    </div>
  );
}

/**
 * The "Progress by skill" card — carousel of per-skill 30-day trends.
 * Renders independently of the diagnostic history (its own fetch), so a
 * user with practice activity but zero diagnostic runs still sees trends.
 */
function SkillTrendsBody({
  series,
}: {
  series: UseEndpointOrMockResult<AllSkillSeries>;
}): JSX.Element | null {
  const seriesData = series.data;

  if (series.loading) {
    return (
      <div className="km-progress__state" role="status" aria-busy="true">
        <Bilingual en="Loading skill trends…" kr="불러오는 중…" />
      </div>
    );
  }
  if (seriesData === null) {
    // Unreachable in practice: the series realFn never rejects (per-skill
    // degradation) and the mock loader cannot fail, so post-loading data is
    // always present. `null` (not a dead ErrorCard) satisfies the type-level
    // narrowing without shipping UI that can never render.
    return null;
  }
  if (SERIES_PANELS.every((p) => seriesData[p.key].metric === 'none')) {
    // F-UP-016a — total outage: every series route failed (network down /
    // server unreachable). Five "couldn't load" panels would be honest but
    // noisy; one ErrorCard with a real retry is clearer. Partial failure
    // still renders the carousel with per-panel "Couldn't load" states.
    return (
      <ErrorCard
        message="Progress trends couldn’t be loaded."
        onRetry={series.refetch}
      />
    );
  }
  return (
    <>
      {/* F-141 — the section's own CollapsibleTile header now carries the
          bilingual name ("Progress by skill" / "실력 추이"); this eyebrow
          keeps only the window meta so the name is never said twice. */}
      <Eyebrow>
        <Bilingual
          en={`Last ${String(TREND_WINDOW_DAYS)} days`}
          kr={`최근 ${String(TREND_WINDOW_DAYS)}일`}
        />
      </Eyebrow>
      <SwipeCarousel ariaLabel="Progress by skill">
        {SERIES_PANELS.map((p) => (
          <SkillTrendPanel
            key={p.key}
            skillKey={p.key}
            label={p.label}
            kr={p.kr}
            series={seriesData[p.key]}
          />
        ))}
      </SwipeCarousel>
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// Mock fallback (module-scope per the useEndpointOrMock contract)
// ─────────────────────────────────────────────────────────────

/** Empty on purpose — a network failure must never paint fabricated
 *  progress. Mirrors the Diagnostic screen's empty snapshot fixture. */
async function loadProgressHistoryMock(): Promise<DiagnosticHistoryResponse> {
  await mockDelay();
  return { snapshots: [] };
}

const realFn = (): Promise<DiagnosticHistoryResponse> => getHistory();

// ─────────────────────────────────────────────────────────────
// Chart geometry (viewBox units; SVG scales to container width)
// ─────────────────────────────────────────────────────────────

const W = 640;
const H = 260;
const PAD = { top: 14, right: 76, bottom: 30, left: 36 } as const;
const INNER_W = W - PAD.left - PAD.right;
const INNER_H = H - PAD.top - PAD.bottom;
const Y_TICKS = [0, 25, 50, 75, 100] as const;

function xFor(i: number, n: number): number {
  // A single attempt centers in the plot; division by n-1 needs n >= 2.
  if (n <= 1) return PAD.left + INNER_W / 2;
  return PAD.left + (i * INNER_W) / (n - 1);
}

function yFor(score: number): number {
  return PAD.top + ((100 - score) / 100) * INNER_H;
}

interface SeriesPoint {
  readonly i: number;
  readonly score: number;
}

/**
 * Split a series' present points into runs of CONSECUTIVE attempts. A line
 * is only honest between adjacent attempts; when a middle attempt lacks the
 * dimension the line breaks instead of bridging the gap.
 */
function consecutiveRuns(points: readonly SeriesPoint[]): SeriesPoint[][] {
  const runs: SeriesPoint[][] = [];
  let current: SeriesPoint[] = [];
  for (const p of points) {
    const prev = current[current.length - 1];
    if (prev !== undefined && p.i - prev.i > 1) {
      runs.push(current);
      current = [];
    }
    current.push(p);
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

/**
 * Least-squares linear regression over (i, score) pairs — F-142's "clearer
 * trend line": one smoothed direction line for the Overall series, drawn
 * alongside (not instead of) the raw connect-the-dots line so a noisy
 * per-attempt wobble doesn't read as "no progress." Returns null under 3
 * points (a 2-point regression is identical to the raw line — drawing it
 * would just double the same segment) or a degenerate all-equal-x input
 * (unreachable here since `i` is the unique attempt index; guarded anyway
 * so a future caller can't divide by zero). Endpoints are clamped into the
 * chart's 0–100 score axis like every other plotted value.
 */
function regressionTrend(
  points: readonly SeriesPoint[],
): { x1: number; y1: number; x2: number; y2: number } | null {
  const n = points.length;
  if (n < 3) return null;
  const meanX = points.reduce((acc, p) => acc + p.i, 0) / n;
  const meanY = points.reduce((acc, p) => acc + p.score, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    const dx = p.i - meanX;
    num += dx * (p.score - meanY);
    den += dx * dx;
  }
  if (den === 0) return null;
  const slope = num / den;
  const intercept = meanY - slope * meanX;
  const first = points[0]?.i ?? 0;
  const last = points[n - 1]?.i ?? 0;
  const clamp = (v: number): number => Math.min(100, Math.max(0, v));
  return {
    x1: first,
    y1: clamp(intercept + slope * first),
    x2: last,
    y2: clamp(intercept + slope * last),
  };
}

// ─────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────

function Progress(): JSX.Element {
  const hist = useEndpointOrMock<DiagnosticHistoryResponse>(
    'diagnostic.history',
    loadProgressHistoryMock,
    { realFn },
  );
  // F-017 — the per-skill 30-day trends behind the "Progress by skill"
  // carousel (moved here from Today in P1.2). One fan-out call. Unlike the
  // history read, its realFn never rejects — a failed route degrades that
  // skill to a placeholder panel (fetchSkillSeries owns that), so this
  // source can't trip the mock fallback and paint fixture numbers as real
  // progress.
  const series = useEndpointOrMock<AllSkillSeries>(
    'progress.series',
    loadSkillSeriesMock,
    { realFn: () => fetchSkillSeries(TREND_WINDOW_DAYS) },
  );

  const snapshots = hist.data?.snapshots ?? null;
  // The mock fallback is empty, so "error + nothing to show" is the honest
  // failure state — never dress a failed fetch up as "no history yet".
  const fatalError =
    hist.error !== null && (snapshots === null || snapshots.length === 0)
      ? hist.error
      : null;

  // Publish the latest snapshot's per-skill scores for the chat FAB's
  // discuss-this-page popup (Slice 3). History arrives oldest→newest, so
  // the last entry is the newest run; no runs yet → publish nothing.
  const latestSnapshot =
    snapshots !== null && snapshots.length > 0
      ? snapshots[snapshots.length - 1]
      : undefined;
  useChatContext(
    latestSnapshot !== undefined
      ? {
          pageLabel: 'Progress · 성장',
          summary: `Latest diagnostic: ${latestSnapshot.dimensions
            .map((d) => `${d.label} ${String(Math.round(d.score))}%`)
            .join(', ')}`,
        }
      : null,
  );

  return (
    <section
      className="screen km-progress km-rain-sheen"
      aria-labelledby="progress-title"
      style={{ position: 'relative' }}
    >
      {(hist.isMock || series.isMock) && fatalError === null ? (
        <MockBadge />
      ) : null}

      {/* F-128 device #4 — the Namsan skyline strip carries the real
          page heading; SkylineHeader itself renders plain markup (no
          heading semantics of its own), so `aria-labelledby` above still
          points at a real <h1>. */}
      <SkylineHeader
        className="km-progress__skyline"
        title={
          <>
            <Eyebrow>
              {/* P3b: the page eyebrow renders nav.ts's en/kr pair bilingually. */}
              <Bilingual en={PROGRESS_NAV.eyebrow} kr={PROGRESS_NAV.krEyebrow} />
            </Eyebrow>
            <h1 id="progress-title" className="kr-display km-progress__title">
              {/* P3a: page-title chrome follows the language-display setting. */}
              <Bilingual kr="성장" en="Progress" />
            </h1>
          </>
        }
      />

      {/* F-128 device #2 — a short dancheong-rail accent under the
          skyline. Purely decorative (DancheongRail is aria-hidden itself). */}
      <div className="km-progress__rail-divider">
        <DancheongRail tone="accent" />
      </div>

      {/* F-141 — every section is a CollapsibleTile. The TOPIK-compare
          section is the one the ticket names explicitly as default-OPEN;
          the other two default-collapsed. CollapsibleTile keeps a
          collapsed body mounted (aria-hidden + inert), so every fetch below
          still runs on page load regardless of fold state. */}
      <CollapsibleTile
        className="km-progress__section"
        defaultCollapsed={false}
        title={<Bilingual en="TOPIK compare" kr="TOPIK 비교" />}
      >
        {hist.loading ? (
          <div className="km-progress__state" role="status">
            <Bilingual en="Loading progress…" kr="불러오는 중…" />
          </div>
        ) : fatalError !== null ? (
          <ErrorCard
            message={errorMessageFor(
              fatalError,
              'Could not load your progress history.',
            )}
            onRetry={hist.refetch}
          />
        ) : snapshots !== null ? (
          snapshots.length === 0 ? (
            <EmptyBlockBody />
          ) : (
            <CompareCardBody snapshots={snapshots} />
          )
        ) : null}
      </CollapsibleTile>

      <CollapsibleTile
        className="km-progress__section"
        defaultCollapsed
        title={<Bilingual en="Progress by skill" kr="실력 추이" />}
      >
        <SkillTrendsBody series={series} />
      </CollapsibleTile>

      <CollapsibleTile
        className="km-progress__section"
        defaultCollapsed
        title={<Bilingual en="Mastery" kr="숙달" />}
      >
        <MasteryBody />
      </CollapsibleTile>
    </section>
  );
}

/**
 * F-143 — the ticket asked to remove a "begin today's plan" block and a
 * "gaps / next steps" block from Progress. Neither exists on this page (that
 * copy lives on `Diagnostic.tsx`'s results screen); there was nothing to cut
 * here. Progress.test.tsx pins a regression assertion that these strings
 * never appear on this page.
 */
function EmptyBlockBody(): JSX.Element {
  const navigate = useNavigate();
  return (
    // F-128 devices #3/#6 — a faint giwa roof texture + a giant "성장"
    // hangul watermark behind the empty state (both are decorative CSS
    // layered under the content — see seoul-devices.css).
    <div
      className="km-progress__empty km-giwa km-hangul-watermark"
      data-glyph="성장"
    >
      <Eyebrow>
        <Bilingual en="No attempts yet" kr="아직 기록 없음" />
      </Eyebrow>
      <div className="km-progress__card-title">
        <Bilingual en="Your trend starts here" kr="여기서 성장이 시작돼요" />
      </div>
      <p className="km-progress__note">
        <Bilingual
          en="Finish a diagnostic and every attempt lands on this page — take a second one and the trend lines appear."
          kr="진단을 마치면 모든 회차가 이 페이지에 쌓여요 — 두 번째부터 추이 선이 나타나요."
        />
      </p>
      <Button
        variant="gold"
        onClick={() => {
          navigate('/diagnostic');
        }}
        trailingIcon={<Icon name="arrow-right" size={14} />}
      >
        <Bilingual en="Take the diagnostic" kr="진단 시작" />
      </Button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Populated view
// ─────────────────────────────────────────────────────────────

interface HistoryProps {
  snapshots: DiagnosticHistorySnapshot[];
}

/**
 * F-128 personal-best check for the milestone SealStamp (device #7): true
 * only when the latest attempt's derived Overall beats every prior
 * attempt's Overall. Needs >= 2 attempts — a single attempt has nothing to
 * beat, so a first attempt is never announced as a "new best".
 */
function isNewBest(snapshots: readonly DiagnosticHistorySnapshot[]): boolean {
  const n = snapshots.length;
  if (n < 2) return false;
  const latest = snapshots[n - 1];
  if (latest === undefined) return false;
  const latestOverall = overallOf(latest);
  if (latestOverall === null) return false;
  const priorBest = snapshots
    .slice(0, n - 1)
    .reduce<number | null>((best, s) => {
      const o = overallOf(s);
      if (o === null) return best;
      return best === null ? o : Math.max(best, o);
    }, null);
  return priorBest !== null && latestOverall > priorBest;
}

/**
 * One page of the attempt-history carousel (F-030) — the per-page chrome
 * (meta eyebrow + title) that the standalone cards used to carry, so a
 * swiper always knows which of the three history surfaces they're on.
 */
function HistoryPage({
  metaEn,
  metaKr,
  titleEn,
  titleKr,
  children,
}: {
  metaEn: string;
  metaKr: string;
  titleEn: string;
  titleKr: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="km-progress__historyPage">
      <Eyebrow>
        <Bilingual en={metaEn} kr={metaKr} />
      </Eyebrow>
      <div className="km-progress__historyTitle">
        <Bilingual en={titleEn} kr={titleKr} />
      </div>
      {children}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Compare card — the ONE compare surface (P1.2 reconciliation)
// ─────────────────────────────────────────────────────────────

/**
 * "Where you stand" — the headline compare. `SkillsCompare full` over the
 * LATEST attempt (the TOPIK-level snapshot moved off Today), the retake CTA,
 * and the attempt-history carousel (F-030) as the card's bottom section:
 * Trend → Attempt vs attempt (≥ 2 attempts only) → All attempts, looping
 * (F-029). One card answers every history question instead of three stacked
 * cards competing for the page. No longer its own `Card` (F-141 moved the
 * outer surface to the page's `CollapsibleTile`) — this returns the
 * section's CONTENT only.
 */
function CompareCardBody({ snapshots }: HistoryProps): JSX.Element {
  const navigate = useNavigate();
  const n = snapshots.length;
  const latest = snapshots[snapshots.length - 1];
  if (latest === undefined) {
    // Unreachable: the caller renders CompareCardBody only when n >= 1.
    // Guarded for noUncheckedIndexedAccess.
    return <></>;
  }

  // F-030 page order is fixed by the ticket: trend → attempt-vs-attempt →
  // all attempts. The compare page needs two attempts to compare, so with a
  // single attempt the carousel simply has two pages — never a broken one.
  const pages: JSX.Element[] = [
    <HistoryPage
      key="trend"
      metaEn="Score over attempts · 0–100"
      metaKr="회차별 점수 · 0–100"
      titleEn="Trend"
      titleKr="추이"
    >
      <TrendChart snapshots={snapshots} />
      {n === 1 ? (
        <p className="km-progress__note">
          <Bilingual
            en="One attempt so far — retake the diagnostic and the trend lines appear."
            kr="아직 한 번뿐이에요 — 진단을 다시 하면 추이 선이 나타나요."
          />
        </p>
      ) : null}
    </HistoryPage>,
    ...(n >= 2
      ? [
          <HistoryPage
            key="compare"
            metaEn="Pick any two attempts"
            metaKr="두 회차 선택"
            titleEn="Attempt vs attempt"
            titleKr="회차 비교"
          >
            <AttemptCompare snapshots={snapshots} />
          </HistoryPage>,
        ]
      : []),
    <HistoryPage
      key="attempts"
      metaEn="Oldest first"
      metaKr="오래된 순"
      titleEn="All attempts"
      titleKr="전체 회차"
    >
      <AttemptsTable snapshots={snapshots} />
    </HistoryPage>,
  ];

  return (
    <>
      {/* P3b: the old eyebrow paired two UNRELATED halves ("Latest attempt" /
          "실력 비교") — each label now carries its own true translation. */}
      <Eyebrow>
        <Bilingual en="Latest attempt" kr="최신 회차" />
      </Eyebrow>
      <div className="km-progress__card-title">
        <Bilingual en="Where you stand" kr="현재 실력" />
        {isNewBest(snapshots) ? (
          // F-128 device #7 — a milestone seal when the latest attempt is a
          // new personal best. `km-najeon` (device #9) gives it a sparing
          // mother-of-pearl sheen — this IS the "jewel" moment the doc
          // reserves that device for, not ambient wallpaper.
          <SealStamp
            milestone
            size="sm"
            tone="accent"
            label={<Bilingual en="New best" kr="최고 기록" compact />}
            className="km-najeon"
          />
        ) : null}
      </div>

      {/* F-128 device #5 — the subway-line reading of the attempt COUNT: a
          growing metro line, one station per attempt, filled up to the
          latest. Distinct from the Trend chart below (which reads SCORE
          over time) — this reads volume, how many runs are banked so far. */}
      <div className="km-progress__subwaywrap">
        <SubwayProgress
          steps={n}
          current={n - 1}
          tone="accent"
          label="Diagnostic attempts so far"
          valueText={`Attempt ${String(n)} of ${String(n)}`}
        />
        <p className="km-progress__note km-progress__subwaynote">
          <Bilingual
            en={`${String(n)} attempt${n === 1 ? '' : 's'} so far`}
            kr={`총 ${String(n)}회 진단`}
            compact
          />
        </p>
      </div>

      <SkillsCompare
        variant="full"
        skills={toSkillRows(latest)}
        references={toSkillRefs(latest)}
        defaultRefId={latest.defaultRef}
      />
      <div className="km-progress__retake">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            navigate('/diagnostic');
          }}
          trailingIcon={<Icon name="arrow-right" size={14} />}
        >
          <Bilingual en="Retake diagnostic" kr="진단 다시 하기" />
        </Button>
      </div>
      <div className="km-progress__historyblock">
        <SwipeCarousel ariaLabel="Attempt history" loop>
          {pages}
        </SwipeCarousel>
      </div>
    </>
  );
}

/** The attempt-vs-attempt pickers + signed delta table — one page of the
 *  attempt-history carousel (F-030); its title chrome lives on HistoryPage. */
function AttemptCompare({ snapshots }: HistoryProps): JSX.Element {
  const n = snapshots.length;
  // Stored selection may outlive a history refetch; clamp during render
  // instead of syncing state in an effect. null = "default" (prev vs latest).
  const [fromSel, setFromSel] = useState<number | null>(null);
  const [toSel, setToSel] = useState<number | null>(null);
  const fromIdx = Math.min(fromSel ?? n - 2, n - 1);
  const toIdx = Math.min(toSel ?? n - 1, n - 1);
  const from = snapshots[fromIdx];
  const to = snapshots[toIdx];

  if (from === undefined || to === undefined) {
    // Unreachable: the caller renders AttemptCompare only when n >= 2 and both
    // indices are clamped to [0, n-1]. Guarded for noUncheckedIndexedAccess.
    return <></>;
  }

  return (
    <div>
      <div className="km-progress__selects">
        <label className="km-progress__select-label">
          <Bilingual en="From" kr="시작" />
          <select
            className="km-progress__select focusring"
            value={fromIdx}
            onChange={(e) => {
              setFromSel(Number(e.target.value));
            }}
          >
            {snapshots.map((s, i) => (
              <option key={s.capturedAt} value={i}>
                Attempt {i + 1} · {formatDay(s.capturedAt)}
              </option>
            ))}
          </select>
        </label>
        <label className="km-progress__select-label">
          <Bilingual en="To" kr="끝" />
          <select
            className="km-progress__select focusring"
            value={toIdx}
            onChange={(e) => {
              setToSel(Number(e.target.value));
            }}
          >
            {snapshots.map((s, i) => (
              <option key={s.capturedAt} value={i}>
                Attempt {i + 1} · {formatDay(s.capturedAt)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="km-progress__tablewrap">
        <table className="km-progress__table">
          <caption>
            {/* Visually hidden (AT-only) — the en half keeps the table's
                accessible name stable for existing queries. */}
            <Bilingual
              en={`Score change from attempt ${String(fromIdx + 1)} to attempt ${String(toIdx + 1)}`}
              kr={`${String(fromIdx + 1)}회차에서 ${String(toIdx + 1)}회차까지의 점수 변화`}
            />
          </caption>
          <thead>
            <tr>
              <th scope="col">
                <Bilingual en="Skill" kr="영역" compact />
              </th>
              <th scope="col" className="km-progress__num">
                <Bilingual
                  en={`Attempt ${String(fromIdx + 1)}`}
                  kr={`${String(fromIdx + 1)}회차`}
                  compact
                />
              </th>
              <th scope="col" className="km-progress__num">
                <Bilingual
                  en={`Attempt ${String(toIdx + 1)}`}
                  kr={`${String(toIdx + 1)}회차`}
                  compact
                />
              </th>
              <th scope="col" className="km-progress__num">
                <Bilingual en="Change" kr="변화" compact />
              </th>
            </tr>
          </thead>
          <tbody>
            {SERIES.map((series) => {
              const a = seriesScore(from, series.key);
              const b = seriesScore(to, series.key);
              return (
                <tr key={series.key}>
                  <th scope="row">
                    <span
                      className={`km-progress__key km-progress__key--${series.key}`}
                      aria-hidden="true"
                    />
                    <Bilingual en={series.label} kr={series.kr} compact />
                  </th>
                  <td className="km-progress__num">{a ?? '—'}</td>
                  <td className="km-progress__num">{b ?? '—'}</td>
                  <td className="km-progress__num">
                    <DeltaCell from={a} to={b} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Signed delta with an arrow so direction never rides on color alone. */
function DeltaCell({ from, to }: { from: number | null; to: number | null }): JSX.Element {
  if (from === null || to === null) return <span>—</span>;
  const delta = to - from;
  if (delta === 0) return <span>= 0</span>;
  const up = delta > 0;
  return (
    <span
      className={up ? 'km-progress__delta--up' : 'km-progress__delta--down'}
    >
      {up ? '▲' : '▼'} {up ? '+' : ''}
      {delta}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────
// Trend chart
// ─────────────────────────────────────────────────────────────

function TrendChart({ snapshots }: HistoryProps): JSX.Element {
  const n = snapshots.length;
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  // The readout defaults to the latest attempt so its values are visible
  // without any pointer at all — the hover layer enhances, never gates.
  const readoutIdx = hoverIdx ?? n - 1;
  const readoutSnap = snapshots[readoutIdx];

  const xs = snapshots.map((_, i) => xFor(i, n));
  const ref = refLine(snapshots);

  // Label every attempt when they fit; thin to ~8 labels beyond that.
  const labelStep = n <= 8 ? 1 : Math.ceil(n / 8);

  // F-142 — a dashed least-squares trend line over the Overall series only
  // (the derived aggregate is the one line worth smoothing; per-dimension
  // noise is exactly what the raw lines already show honestly).
  const overallSeriesPoints: SeriesPoint[] = [];
  snapshots.forEach((s, i) => {
    const score = seriesScore(s, 'overall');
    if (score !== null) overallSeriesPoints.push({ i, score });
  });
  const overallTrend = regressionTrend(overallSeriesPoints);

  return (
    <div>
      <div className="km-progress__chartwrap">
        <svg
          className="km-progress__svg"
          viewBox={`0 0 ${String(W)} ${String(H)}`}
          role="img"
          aria-label={`Line chart of diagnostic scores across ${String(n)} attempt${
            n === 1 ? '' : 's'
          }. All values are listed in the attempts table below.`}
        >
          {/* Grid + y ticks */}
          {Y_TICKS.map((t) => (
            <g key={`grid-${String(t)}`}>
              <line
                className={t === 0 ? 'km-progress__axis' : 'km-progress__grid'}
                x1={PAD.left}
                x2={W - PAD.right}
                y1={yFor(t)}
                y2={yFor(t)}
              />
              <text
                className="km-progress__tick"
                x={PAD.left - 6}
                y={yFor(t) + 3}
                textAnchor="end"
              >
                {t}
              </text>
            </g>
          ))}

          {/* TOPIK reference threshold (dashed = threshold, not grid) */}
          {ref !== null ? (
            <g>
              <line
                className="km-progress__refline"
                x1={PAD.left}
                x2={W - PAD.right}
                y1={yFor(ref.value)}
                y2={yFor(ref.value)}
              />
              <text
                className="km-progress__reflabel"
                x={W - PAD.right + 6}
                y={yFor(ref.value) + 3}
              >
                {ref.label}
              </text>
            </g>
          ) : null}

          {/* Crosshair for the hovered/focused attempt */}
          {hoverIdx !== null ? (
            <line
              className="km-progress__crosshair"
              x1={xs[hoverIdx]}
              x2={xs[hoverIdx]}
              y1={PAD.top}
              y2={H - PAD.bottom}
            />
          ) : null}

          {/* X labels (attempt dates) */}
          {snapshots.map((s, i) =>
            i % labelStep === 0 || i === n - 1 ? (
              <text
                key={`x-${s.capturedAt}`}
                className="km-progress__tick"
                x={xs[i]}
                y={H - PAD.bottom + 16}
                textAnchor="middle"
              >
                {formatDay(s.capturedAt)}
              </text>
            ) : null,
          )}

          {/* Series lines + markers */}
          {SERIES.map((series) => {
            const points: SeriesPoint[] = [];
            snapshots.forEach((s, i) => {
              const score = seriesScore(s, series.key);
              if (score !== null) points.push({ i, score });
            });
            const lastPoint = points[points.length - 1];
            return (
              <g key={series.key}>
                {consecutiveRuns(points).map(
                  (run) =>
                    run.length >= 2 ? (
                      <polyline
                        key={`run-${series.key}-${String(run[0]?.i ?? 0)}`}
                        className={`km-progress__line km-progress__series--${series.key}`}
                        points={run
                          .map((p) => `${String(xFor(p.i, n))},${String(yFor(p.score))}`)
                          .join(' ')}
                      />
                    ) : null,
                )}
                {series.key === 'overall' && overallTrend !== null ? (
                  <line
                    className="km-progress__trendfit"
                    x1={xFor(overallTrend.x1, n)}
                    y1={yFor(overallTrend.y1)}
                    x2={xFor(overallTrend.x2, n)}
                    y2={yFor(overallTrend.y2)}
                  />
                ) : null}
                {points.map((p, idx) => {
                  // Every attempt already gets a marker (F-142 "visible data
                  // points"); the latest per series is emphasized (larger,
                  // thicker ring) so the current standing reads at a glance.
                  const isLatest = idx === points.length - 1;
                  return (
                    <circle
                      key={`dot-${series.key}-${String(p.i)}`}
                      className={cn(
                        'km-progress__dot',
                        `km-progress__fill--${series.key}`,
                        isLatest && 'km-progress__dot--latest',
                      )}
                      cx={xFor(p.i, n)}
                      cy={yFor(p.score)}
                      r={isLatest ? 5.5 : 4}
                    />
                  );
                })}
                {/* Selective direct label: the Overall endpoint only — the
                    legend + readout + table carry everything else. */}
                {series.key === 'overall' && lastPoint !== undefined ? (
                  <text
                    className="km-progress__endlabel"
                    x={xFor(lastPoint.i, n) + 8}
                    y={yFor(lastPoint.score) - 8}
                  >
                    Overall {lastPoint.score}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>

        {/* Keyboard-reachable hover layer: one real button per attempt. */}
        {snapshots.map((s, i) => {
          const startX = i === 0 ? PAD.left - 14 : ((xs[i - 1] ?? 0) + (xs[i] ?? 0)) / 2;
          const endX =
            i === n - 1 ? W - PAD.right + 14 : ((xs[i] ?? 0) + (xs[i + 1] ?? 0)) / 2;
          return (
            <button
              key={`hit-${s.capturedAt}`}
              type="button"
              className="km-progress__hitcol focusring"
              style={{
                left: `${String((startX / W) * 100)}%`,
                width: `${String(((endX - startX) / W) * 100)}%`,
              }}
              aria-label={attemptSummary(s, i)}
              onMouseEnter={() => {
                setHoverIdx(i);
              }}
              onMouseLeave={() => {
                setHoverIdx(null);
              }}
              onFocus={() => {
                setHoverIdx(i);
              }}
              onBlur={() => {
                setHoverIdx(null);
              }}
            />
          );
        })}
      </div>

      {/* Live readout — the tooltip's always-visible home. Values lead.
          role="status" = implicit polite live region, and gives the block an
          accessible handle distinct from the comparison pickers' options. */}
      <div className="km-progress__readout" role="status">
        <span>
          {/* compact: the readout is tight chrome — one language visually,
              both in the accessible reading (the primitive's sr-only). */}
          <Bilingual
            en={`Attempt ${String(readoutIdx + 1)}${
              readoutSnap !== undefined ? ` · ${formatDay(readoutSnap.capturedAt)}` : ''
            }`}
            kr={`${String(readoutIdx + 1)}회차${
              readoutSnap !== undefined ? ` · ${formatDay(readoutSnap.capturedAt)}` : ''
            }`}
            compact
          />
        </span>
        {readoutSnap !== undefined
          ? SERIES.map((series) => {
              const score = seriesScore(readoutSnap, series.key);
              return (
                <span key={series.key}>
                  <span
                    className={`km-progress__key km-progress__key--${series.key}`}
                    aria-hidden="true"
                  />
                  <span className="km-progress__readout-value">
                    {score !== null ? score : '—'}
                  </span>{' '}
                  <Bilingual en={series.label} kr={series.kr} compact />
                </span>
              );
            })
          : null}
      </div>

      <ul className="km-progress__legend" aria-label="Chart series">
        {SERIES.map((series) => (
          <li key={series.key}>
            <span
              className={`km-progress__key km-progress__key--${series.key}`}
              aria-hidden="true"
            />
            <Bilingual en={series.label} kr={series.kr} />
          </li>
        ))}
      </ul>

      {/* F-142 — names what the dashed overlay means; only appears when it's
          actually drawn (>= 3 attempts). */}
      {overallTrend !== null ? (
        <p className="km-progress__trendnote">
          <Bilingual
            en="Dashed line: overall trend across attempts"
            kr="점선: 전체 회차 추이"
          />
        </p>
      ) : null}
    </div>
  );
}

/** The default TOPIK reference threshold to draw (e.g. L4 = 55). */
function refLine(
  snapshots: readonly DiagnosticHistorySnapshot[],
): { label: string; value: number } | null {
  const latest = snapshots[snapshots.length - 1];
  if (latest === undefined) return null;
  const found = latest.references.find((r) => r.id === latest.defaultRef);
  return found ? { label: found.label, value: found.value } : null;
}

/** Accessible per-attempt summary — same details focus/hover reveal. */
function attemptSummary(snap: DiagnosticHistorySnapshot, i: number): string {
  const parts = SERIES.map((series) => {
    const score = seriesScore(snap, series.key);
    return `${series.label} ${score !== null ? String(score) : 'not scored'}`;
  });
  return `Attempt ${String(i + 1)}, ${formatDay(snap.capturedAt)}: ${parts.join(', ')}`;
}

// ─────────────────────────────────────────────────────────────
// All attempts table (the chart's accessible twin)
// ─────────────────────────────────────────────────────────────

function AttemptsTable({ snapshots }: HistoryProps): JSX.Element {
  return (
    <div className="km-progress__tablewrap">
      <table className="km-progress__table">
        <caption>
          <Bilingual
            en="All diagnostic attempts, oldest first"
            kr="전체 진단 회차, 오래된 순"
          />
        </caption>
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">
              <Bilingual en="Date" kr="날짜" compact />
            </th>
            {SERIES.map((series) => (
              <th scope="col" key={series.key} className="km-progress__num">
                <Bilingual en={series.label} kr={series.kr} compact />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {snapshots.map((s, i) => (
            <tr key={s.capturedAt}>
              <th scope="row">{i + 1}</th>
              <td>{formatDay(s.capturedAt)}</td>
              {SERIES.map((series) => (
                <td key={series.key} className="km-progress__num">
                  {seriesScore(s, series.key) ?? '—'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Word mastery (F-013)
// ─────────────────────────────────────────────────────────────

const MASTERY_PAGE = 30;

/** Bucket chrome labels (P3b: en/kr pairs — the FSRS bucket NAME is chrome;
 *  the words inside the buckets are content and never touched). */
const BUCKET_META: Record<
  MasteryBucket,
  { label: string; kr: string; cls: string }
> = {
  new: { label: 'New', kr: '신규', cls: 'is-new' },
  learning: { label: 'Learning', kr: '학습 중', cls: 'is-learning' },
  reviewing: { label: 'Reviewing', kr: '복습 중', cls: 'is-reviewing' },
  mastered: { label: 'Mastered', kr: '숙달', cls: 'is-mastered' },
};
const BUCKET_ORDER: readonly MasteryBucket[] = [
  'new',
  'learning',
  'reviewing',
  'mastered',
];

/** Proportion bar + tappable bucket legend — each chip filters the word list. */
function MasteryBar({
  summary,
  selected,
  onSelect,
}: {
  summary: MasterySummary;
  selected: MasteryBucket | null;
  onSelect: (bucket: MasteryBucket | null) => void;
}): JSX.Element {
  const denom = Math.max(1, summary.total);
  return (
    <div className="km-mastery__summary">
      <div
        className="km-mastery__bar"
        role="img"
        aria-label={`${String(summary.mastered)} mastered, ${String(
          summary.reviewing,
        )} reviewing, ${String(summary.learning)} learning, ${String(
          summary.new,
        )} new`}
      >
        {BUCKET_ORDER.map((b) =>
          summary[b] > 0 ? (
            <span
              key={b}
              className={`km-mastery__seg ${BUCKET_META[b].cls}`}
              style={{ width: `${String((summary[b] / denom) * 100)}%` }}
            />
          ) : null,
        )}
      </div>
      <div className="km-mastery__legend">
        {BUCKET_ORDER.map((b) => (
          <button
            key={b}
            type="button"
            className={`km-mastery__chip ${BUCKET_META[b].cls}${
              selected === b ? ' is-active' : ''
            }`}
            aria-pressed={selected === b}
            onClick={() => {
              onSelect(selected === b ? null : b);
            }}
          >
            <span className="km-mastery__dot" aria-hidden="true" />
            <Bilingual
              en={BUCKET_META[b].label}
              kr={BUCKET_META[b].kr}
              compact
            />{' '}
            <b>{summary[b]}</b>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Referentially-stable empty list so `usePagination` gets the same array
 *  every render while the mastery page is still loading. */
const NO_WORDS: readonly MasteryWord[] = [];

/** The last successfully-loaded server page PLUS the offset it was fetched
 *  at. Prev/Next move the REQUESTED offset immediately, but on a failed
 *  refetch the stale page stays up (keep-stale-on-failure) — so the range
 *  text and the Prev/Next disabled states must describe what is actually
 *  SHOWN, i.e. this offset, never the phantom requested one. */
interface LoadedMasteryPage {
  data: MasteryPage;
  offset: number;
}

/** Mastery-tab panel (F-013/F-031): per-word FSRS mastery — summary + a
 *  filterable list, windowed client-side (15 → +15 → 30) over the 30-word
 *  server page. */
function WordMasteryPanel(): JSX.Element {
  const [bucket, setBucket] = useState<MasteryBucket | null>(null);
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<LoadedMasteryPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  // F-031 — the visible window over the CURRENT server page. usePagination's
  // defaults (15 initial / +15 step / 30 max) are exactly the ticket's spec,
  // and the 30 cap equals MASTERY_PAGE, so "Show more" can always reveal the
  // whole loaded page and never promises words that weren't fetched.
  const pager = usePagination(page?.data.words ?? NO_WORDS);

  // What the list is actually showing (see LoadedMasteryPage). Before the
  // first load there is nothing shown, so 0 is the honest default.
  const shownOffset = page?.offset ?? 0;

  // Selecting a bucket (or toggling it off) always returns to page 1 — done in
  // the handler, NOT a separate effect, so one tap triggers ONE fetch not two.
  // The F-031 window collapses back to 15 with it.
  function selectBucket(next: MasteryBucket | null): void {
    setBucket(next);
    setOffset(0);
    pager.reset();
  }
  function retry(): void {
    setNonce((n) => n + 1);
  }
  // Prev/Next navigate relative to the SHOWN page (a failed hop must not
  // compound — Next after a failed Next re-requests the same target, not one
  // page further). The nonce bump forces a refetch even when the failed hop
  // already left `offset` at the target value. The F-031 window resets with
  // every page move.
  function goToOffset(target: number): void {
    setOffset(target);
    setNonce((n) => n + 1);
    pager.reset();
  }

  // Real-data-only on purpose — NOT wired through useEndpointOrMock: (1) that
  // hook resets data→null on every key change, which would wipe the loaded list
  // on each bucket/page switch and break the graceful keep-stale-on-refetch-
  // failure behaviour below (which depends on retaining `page`); and (2) it falls
  // back to a mockFn on failure, and fake mastery numbers would misrepresent real
  // progress. The effect cleanup aborts the in-flight request on re-run/unmount.
  useEffect(() => {
    const ctrl = new AbortController();
    /* eslint-disable react-hooks/set-state-in-effect */
    setLoading(true);
    setError(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    fetchMastery(
      { ...(bucket !== null ? { bucket } : {}), limit: MASTERY_PAGE, offset },
      ctrl.signal,
    )
      .then((res) => {
        if (ctrl.signal.aborted) return;
        // Stale-offset guard: the data shrank server-side and this offset now
        // points past the end (e.g. offset 30 against a total of 25). Showing
        // "No words in this group." with the pager hidden would strand the
        // user in an inescapable empty view — clamp to the last valid page
        // instead; the offset change refires this effect (loading stays on).
        // The clamp strictly decreases the offset, so it terminates.
        if (offset > 0 && offset >= res.total) {
          setOffset(
            Math.max(0, (Math.ceil(res.total / MASTERY_PAGE) - 1) * MASTERY_PAGE),
          );
          return;
        }
        setPage({ data: res, offset });
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.code === 'canceled') return;
        setError(
          errorMessageFor(err, 'Could not load word mastery.'),
        );
        setLoading(false);
      });
    return () => {
      ctrl.abort();
    };
  }, [bucket, offset, nonce]);

  return (
    <div>
      {page === null ? (
        loading ? (
          <div className="km-progress__state">
            <Bilingual en="Loading word mastery…" kr="불러오는 중…" />
          </div>
        ) : error !== null ? (
          <ErrorCard message={error} onRetry={retry} />
        ) : null
      ) : page.data.summary.total === 0 ? (
        <p className="km-progress__note">
          {/* P3b verbage trim — was a two-clause tour of the add-word flow. */}
          <Bilingual
            en="No vocab cards yet — add words from Listen and their mastery shows here."
            kr="아직 단어 카드가 없어요 — 듣기에서 단어를 추가하면 숙달도가 여기에 나와요."
          />
        </p>
      ) : (
        <>
          {error !== null ? (
            <p className="km-mastery__stale" role="alert">
              <Bilingual
                en="Couldn’t refresh — showing the last loaded mastery."
                kr="새로고침하지 못했어요 — 마지막으로 불러온 내용이에요."
              />{' '}
              <button
                type="button"
                className="km-mastery__retry"
                onClick={retry}
              >
                <Bilingual en="Retry" kr="다시 시도" compact />
              </button>
            </p>
          ) : null}
          <MasteryBar
            summary={page.data.summary}
            selected={bucket}
            onSelect={selectBucket}
          />
          {page.data.words.length === 0 ? (
            <p className="km-progress__note">
              <Bilingual
                en="No words in this group."
                kr="이 그룹에는 단어가 없어요."
              />
            </p>
          ) : (
            <>
              <ul className="km-mastery__list">
                {pager.visible.map((w) => (
                  <li key={w.id} className="km-mastery__row">
                    <span className="kr km-mastery__kr">{w.korean}</span>
                    <span className="km-mastery__en">{w.english ?? ''}</span>
                    <span
                      className={`km-mastery__badge ${BUCKET_META[w.bucket].cls}`}
                    >
                      <Bilingual
                        en={BUCKET_META[w.bucket].label}
                        kr={BUCKET_META[w.bucket].kr}
                        compact
                      />
                    </span>
                    <span className="km-mastery__stab">
                      {w.bucket === 'new'
                        ? '—'
                        : `${String(Math.round(w.stability))}d`}
                    </span>
                  </li>
                ))}
              </ul>
              {/* F-031 — reveal the rest of the loaded page in +15 windows. */}
              <ShowMore
                canShowMore={pager.canShowMore}
                onShowMore={pager.showMore}
                remaining={pager.remaining}
              />
            </>
          )}
          {/* The pager also stays visible whenever the SHOWN page sits past
              the start — even if a refetch reported a shrunken total — so
              the user always has a Prev to escape with. */}
          {page.data.total > MASTERY_PAGE || page.offset > 0 ? (
            <div className="km-mastery__pager">
              <Button
                variant="ghost"
                disabled={shownOffset === 0}
                onClick={() => {
                  goToOffset(Math.max(0, shownOffset - MASTERY_PAGE));
                }}
              >
                <Bilingual en="Prev" kr="이전" compact />
              </Button>
              <span className="km-mastery__pageinfo">
                {/* Both bounds describe what is actually SHOWN: the window's
                    length (F-031) over the shown page's fetched-at offset —
                    never the phantom offset of a failed Prev/Next hop. */}
                <Bilingual
                  en={`${String(shownOffset + 1)}–${String(
                    shownOffset + pager.visible.length,
                  )} of ${String(page.data.total)}`}
                  kr={`${String(page.data.total)}개 중 ${String(
                    shownOffset + 1,
                  )}–${String(shownOffset + pager.visible.length)}`}
                  compact
                />
              </span>
              <Button
                variant="ghost"
                disabled={shownOffset + MASTERY_PAGE >= page.data.total}
                onClick={() => {
                  goToOffset(shownOffset + MASTERY_PAGE);
                }}
              >
                <Bilingual en="Next" kr="다음" compact />
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Grammar mastery — designed placeholder (real route lands in P4)
// ─────────────────────────────────────────────────────────────

/**
 * Grammar mastery placeholder — the Grammar tab of the F-032 mastery area.
 * The backing read route (mirroring `/vocab/mastery` over the grammar
 * production-card FSRS state) is a P4 feature; until then this is an
 * intentional coming-soon panel, never a blank or broken one.
 */
function GrammarMasteryPanel(): JSX.Element {
  return (
    <div>
      <div className="km-progress__soonhead">
        <Pill>
          <Bilingual en="Coming soon" kr="준비 중" />
        </Pill>
      </div>
      <div className="km-progress__soonbody">
        <span className="km-progress__soonicon" aria-hidden="true">
          <Icon name="grammar" size={18} />
        </span>
        <p className="km-progress__note">
          {/* P3b verbage trim — one terse line, was a three-clause sentence. */}
          <Bilingual
            en="Per-pattern grammar mastery will chart here."
            kr="문형별 숙달도가 여기에 표시될 거예요."
          />
        </p>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Hanja mastery (F-041) — aggregate bands from GET /hanja/progress
// ─────────────────────────────────────────────────────────────

/** Hanja band chrome — mirrors the Hanja screen's state labels (P3b:
 *  `banked` uses the 담기/담김 family per the glossary). */
const HANJA_BAND_META: ReadonlyArray<{
  key: 'banked' | 'practicing' | 'new';
  label: string;
  kr: string;
  cls: string;
}> = [
  { key: 'banked', label: 'Banked', kr: '담김', cls: 'is-banked' },
  { key: 'practicing', label: 'Practicing', kr: '연습 중', cls: 'is-practicing' },
  { key: 'new', label: 'New', kr: '신규', cls: 'is-new' },
];

/**
 * Mastery-tab panel (F-041): the user's aggregate hanja standing from
 * `GET /hanja/progress` — a banked/practicing/new proportion bar (same
 * visual family as the word-mastery bar) plus the Encountered-vs-L4 band.
 * The route aggregates counts (per-character FSRS lands with F-075), so
 * this reads as the mastery summary, not a character list.
 *
 * Same direct-fetch pattern as WordMasteryPanel (real-data-only, abortable,
 * never a mock fallback — fake mastery numbers would misrepresent real
 * progress). A user who hasn't touched any hanja gets an invitation, not a
 * crash or an all-zero bar.
 */
function HanjaMasteryPanel(): JSX.Element {
  const [progress, setProgress] = useState<HanjaProgress | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  function retry(): void {
    setNonce((n) => n + 1);
  }

  useEffect(() => {
    const ctrl = new AbortController();
    /* eslint-disable react-hooks/set-state-in-effect */
    setLoading(true);
    setError(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    fetchHanjaProgress(ctrl.signal)
      .then((res) => {
        if (ctrl.signal.aborted) return;
        setProgress(res);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof ApiError && err.code === 'canceled') return;
        setError(errorMessageFor(err, 'Could not load hanja mastery.'));
        setLoading(false);
      });
    return () => {
      ctrl.abort();
    };
  }, [nonce]);

  if (loading) {
    return (
      <div className="km-progress__state">
        <Bilingual en="Loading hanja mastery…" kr="불러오는 중…" />
      </div>
    );
  }
  if (error !== null || progress === null) {
    return (
      <ErrorCard
        message={error ?? 'Could not load hanja mastery.'}
        onRetry={retry}
      />
    );
  }

  // "Empty for this user" = no progress rows at all (encountered counts ANY
  // row; banked/practicing are its stateful subsets). `new` alone can be the
  // whole corpus for a fresh user, so it must NOT count as activity.
  if (progress.banked + progress.practicing + progress.encountered === 0) {
    return (
      <p className="km-progress__note">
        <Bilingual
          en="No hanja studied yet — mark characters as practicing or banked in Learn → Hanja and your mastery shows here."
          kr="아직 학습한 한자가 없어요 — 한자 페이지에서 연습 중/담김으로 표시하면 숙달도가 여기에 나와요."
        />
      </p>
    );
  }

  const denom = Math.max(
    1,
    progress.banked + progress.practicing + progress.new,
  );
  const encounteredPct =
    progress.targetL4 > 0
      ? Math.min(100, (progress.encountered / progress.targetL4) * 100)
      : 0;

  return (
    <div className="km-mastery__summary">
      <div
        className="km-mastery__bar"
        role="img"
        aria-label={`${String(progress.banked)} banked, ${String(
          progress.practicing,
        )} practicing, ${String(progress.new)} new`}
      >
        {HANJA_BAND_META.map((b) =>
          progress[b.key] > 0 ? (
            <span
              key={b.key}
              className={`km-mastery__seg ${b.cls}`}
              style={{ width: `${String((progress[b.key] / denom) * 100)}%` }}
            />
          ) : null,
        )}
      </div>
      <div className="km-mastery__legend">
        {/* Static stats, not filter chips — this panel has no list to
            filter (per-character cards land with F-075). */}
        {HANJA_BAND_META.map((b) => (
          <span key={b.key} className={`km-mastery__stat ${b.cls}`}>
            <span className="km-mastery__dot" aria-hidden="true" />
            <Bilingual en={b.label} kr={b.kr} compact /> <b>{progress[b.key]}</b>
          </span>
        ))}
      </div>
      <div className="km-hmastery__band">
        <Eyebrow>
          <Bilingual
            en={`Encountered · ${String(progress.encountered)} of ~${String(progress.targetL4)} at L4`}
            kr={`접한 한자 · ${String(progress.encountered)} / 약 ${String(progress.targetL4)} (L4 기준)`}
          />
        </Eyebrow>
        {/* Clamped/degenerate-safe ARIA — shared with Hanja's
            EncounteredBand via lib/encounteredBar. */}
        <div
          className="km-hmastery__bar"
          {...encounteredBarAria(progress.encountered, progress.targetL4)}
        >
          <div
            className="km-hmastery__fill"
            style={{ width: `${encounteredPct.toFixed(1)}%` }}
          />
        </div>
        {/* Server-templated status line — rendered as a React child. */}
        <p className="km-progress__note">{progress.note}</p>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Mastery area (F-032) — Words / Grammar / Hanja as one tabbed card
// ─────────────────────────────────────────────────────────────

const MASTERY_TABS: ReadonlyArray<TabItem> = [
  { id: 'words', label: <Bilingual en="Words" kr="단어" compact /> },
  { id: 'grammar', label: <Bilingual en="Grammar" kr="문법" compact /> },
  { id: 'hanja', label: <Bilingual en="Hanja" kr="한자" compact /> },
];

/**
 * The F-032 mastery card: Word / Grammar / Hanja mastery share ONE area
 * behind the Phase-1 `Tabs` primitive instead of stacking three cards.
 * Panels are lazy (Tabs renders only the active one) and re-keyed per tab,
 * so each panel owns its fetch lifecycle — an aborted switch never leaks a
 * request or state into the next tab.
 */
function MasteryBody(): JSX.Element {
  return (
    <Tabs tabs={MASTERY_TABS} ariaLabel="Mastery">
      {(activeId) =>
        activeId === 'grammar' ? (
          <GrammarMasteryPanel />
        ) : activeId === 'hanja' ? (
          <HanjaMasteryPanel />
        ) : (
          <WordMasteryPanel />
        )
      }
    </Tabs>
  );
}

export default Progress;
