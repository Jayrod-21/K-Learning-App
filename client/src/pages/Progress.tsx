/**
 * Progress — the stats hub (Overhaul P1.2, Slice A).
 *
 * P1.2 rebalanced Today/Progress: Today is now the ACTION hub, and every
 * "where am I" surface lives here. The page renders, top to bottom:
 *
 *   1. **Where you stand** — `SkillsCompare` (variant `full`) over the LATEST
 *      diagnostic attempt, with the TOPIK-1→Native reference picker. This is
 *      the single headline compare surface (moved off Today, where it was the
 *      `compact` snapshot). The old standalone "Comparison" card was folded in
 *      here as the **Attempt vs attempt** sub-block (two pickers + a signed
 *      delta table, shown when ≥ 2 attempts) so there is ONE compare card,
 *      not two competing ones. A **Retake diagnostic** button lives in this
 *      populated card (previously the CTA existed only in the empty state).
 *   2. **Trend** — the inline-SVG line chart of diagnostic scores across
 *      attempts (one 2px line per dimension + a neutral Overall line),
 *      with its keyboard-reachable hover readout.
 *   3. **All attempts table** — the chart's accessible twin; every plotted
 *      value is readable without a pointer.
 *   4. **Progress by skill** (F-017, moved from Today) — a `SwipeCarousel`
 *      of five `SkillTrendPanel` pages (Reading / Listening / Vocab /
 *      Grammar / Writing), each a `LineChart` of that skill's 30-day series.
 *      Independent of the diagnostic history — it renders (or errors) on its
 *      own fetch, so a user with practice activity but no diagnostic still
 *      sees their trends.
 *   5. **Word mastery** (F-013) — per-word FSRS buckets, filterable list.
 *   6. **Grammar mastery** — a designed "coming soon" placeholder (the real
 *      route + section land in P4).
 *
 * Data:
 *   useEndpointOrMock('diagnostic.history', …, { realFn: getHistory })       → DiagnosticHistoryResponse
 *   useEndpointOrMock('progress.series', …, { realFn: fetchSkillSeries })    → AllSkillSeries (F-017)
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
 *     scopes every query to the session user.
 *   - **Mock fallback honesty.** The history mock loader resolves an EMPTY
 *     history (mirroring the Diagnostic screen's empty fixture) so a
 *     real-endpoint failure can never paint fabricated progress; when the
 *     real call fails and the fallback is empty we show the error card, not
 *     a fake state. The series source can't trip the mock fallback at all —
 *     its realFn never rejects (per-skill degradation).
 */
import { useEffect, useState, type JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bilingual } from '../components/Bilingual';
import { Card } from '../components/Card';
import { Button } from '../components/Button';
import { Eyebrow } from '../components/Eyebrow';
import { Icon } from '../components/Icon';
import { MockBadge } from '../components/MockBadge';
import { ErrorCard } from '../components/ErrorCard';
import { LineChart } from '../components/LineChart';
import { Pill } from '../components/Pill';
import { SkillsCompare } from '../components/SkillsCompare';
import type { SkillReference, SkillRow } from '../components/SkillsCompare';
import { SwipeCarousel } from '../components/SwipeCarousel';
import { useEndpointOrMock } from '../hooks/useEndpointOrMock';
import type { UseEndpointOrMockResult } from '../hooks/useEndpointOrMock';
import { navItem } from '../lib/nav';
import { getHistory } from '../services/diagnostic';
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
  MasteryBucket,
  MasteryPage,
  MasterySummary,
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
function SkillTrendsCard({
  series,
}: {
  series: UseEndpointOrMockResult<AllSkillSeries>;
}): JSX.Element | null {
  const seriesData = series.data;

  if (series.loading) {
    return (
      <Card className="km-progress__card" aria-busy="true">
        <div className="km-progress__state" role="status">
          <Bilingual en="Loading skill trends…" kr="불러오는 중…" />
        </div>
      </Card>
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
      <div className="km-progress__card">
        <ErrorCard
          message="Progress trends couldn’t be loaded."
          onRetry={series.refetch}
        />
      </div>
    );
  }
  return (
    <Card className="km-progress__card">
      {/* P3b trim — "실력 추이" repeated the title's meaning; the eyebrow
          keeps only the window meta, the title carries the bilingual name. */}
      <Eyebrow>
        <Bilingual
          en={`Last ${String(TREND_WINDOW_DAYS)} days`}
          kr={`최근 ${String(TREND_WINDOW_DAYS)}일`}
        />
      </Eyebrow>
      <div className="km-progress__card-title">
        <Bilingual en="Progress by skill" kr="실력 추이" />
      </div>
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
    </Card>
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

  return (
    <section
      className="screen km-progress"
      aria-labelledby="progress-title"
      style={{ position: 'relative' }}
    >
      {(hist.isMock || series.isMock) && fatalError === null ? (
        <MockBadge />
      ) : null}

      <Eyebrow>
        {/* P3b: the page eyebrow renders nav.ts's en/kr pair bilingually. */}
        <Bilingual en={PROGRESS_NAV.eyebrow} kr={PROGRESS_NAV.krEyebrow} />
      </Eyebrow>
      <h1 id="progress-title" className="kr-display km-progress__title">
        {/* P3a: page-title chrome follows the language-display setting. */}
        <Bilingual kr="성장" en="Progress" />
      </h1>

      {hist.loading ? (
        <div className="km-progress__state" role="status">
          <Bilingual en="Loading progress…" kr="불러오는 중…" />
        </div>
      ) : null}

      {!hist.loading && fatalError !== null ? (
        <ErrorCard
          message={errorMessageFor(
            fatalError,
            'Could not load your progress history.',
          )}
          onRetry={hist.refetch}
        />
      ) : null}

      {!hist.loading && fatalError === null && snapshots !== null ? (
        snapshots.length === 0 ? (
          <EmptyBlock />
        ) : (
          <HistoryBlocks snapshots={snapshots} />
        )
      ) : null}

      <SkillTrendsCard series={series} />

      <WordMasterySection />

      <GrammarMasterySection />
    </section>
  );
}

function EmptyBlock(): JSX.Element {
  const navigate = useNavigate();
  return (
    <Card className="km-progress__card">
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
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────
// Populated view
// ─────────────────────────────────────────────────────────────

interface HistoryProps {
  snapshots: DiagnosticHistorySnapshot[];
}

function HistoryBlocks({ snapshots }: HistoryProps): JSX.Element {
  const n = snapshots.length;
  return (
    <>
      <CompareCard snapshots={snapshots} />

      <Card className="km-progress__card">
        <Eyebrow>
          <Bilingual en="Score over attempts · 0–100" kr="회차별 점수 · 0–100" />
        </Eyebrow>
        <div className="km-progress__card-title">
          <Bilingual en="Trend" kr="추이" />
        </div>
        <TrendChart snapshots={snapshots} />
        {n === 1 ? (
          <p className="km-progress__note">
            <Bilingual
              en="One attempt so far — retake the diagnostic and the trend lines appear."
              kr="아직 한 번뿐이에요 — 진단을 다시 하면 추이 선이 나타나요."
            />
          </p>
        ) : null}
      </Card>

      <Card className="km-progress__card">
        {/* P3b trim — "Every attempt" repeated the title; the eyebrow keeps
            only the ordering meta. */}
        <Eyebrow>
          <Bilingual en="Oldest first" kr="오래된 순" />
        </Eyebrow>
        <div className="km-progress__card-title">
          <Bilingual en="All attempts" kr="전체 회차" />
        </div>
        <AttemptsTable snapshots={snapshots} />
      </Card>
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// Compare card — the ONE compare surface (P1.2 reconciliation)
// ─────────────────────────────────────────────────────────────

/**
 * "Where you stand" — the headline compare. `SkillsCompare full` over the
 * LATEST attempt (the TOPIK-level snapshot moved off Today), the retake CTA,
 * and — with ≥ 2 attempts — the attempt-vs-attempt delta table folded in as
 * a sub-block. One card answers both compare questions ("vs TOPIK levels
 * now" and "vs my earlier attempts") instead of two competing widgets.
 */
function CompareCard({ snapshots }: HistoryProps): JSX.Element {
  const navigate = useNavigate();
  const latest = snapshots[snapshots.length - 1];
  if (latest === undefined) {
    // Unreachable: the caller renders HistoryBlocks only when n >= 1.
    // Guarded for noUncheckedIndexedAccess.
    return <></>;
  }
  return (
    <Card className="km-progress__card">
      {/* P3b: the old eyebrow paired two UNRELATED halves ("Latest attempt" /
          "실력 비교") — each label now carries its own true translation. */}
      <Eyebrow>
        <Bilingual en="Latest attempt" kr="최신 회차" />
      </Eyebrow>
      <div className="km-progress__card-title">
        <Bilingual en="Where you stand" kr="현재 실력" />
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
      {snapshots.length >= 2 ? <AttemptCompare snapshots={snapshots} /> : null}
    </Card>
  );
}

/** The attempt-vs-attempt pickers + signed delta table (previously its own
 *  "Comparison" card; now a sub-block of the single compare surface). */
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
    <div className="km-progress__attemptcompare">
      <Eyebrow>
        <Bilingual en="Attempt vs attempt" kr="회차 비교" />
      </Eyebrow>

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
                {points.map((p) => (
                  <circle
                    key={`dot-${series.key}-${String(p.i)}`}
                    className={`km-progress__dot km-progress__fill--${series.key}`}
                    cx={xFor(p.i, n)}
                    cy={yFor(p.score)}
                    r={4}
                  />
                ))}
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

/** Progress-page section: per-word FSRS mastery — summary + a filterable list. */
function WordMasterySection(): JSX.Element {
  const [bucket, setBucket] = useState<MasteryBucket | null>(null);
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<MasteryPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  // Selecting a bucket (or toggling it off) always returns to page 1 — done in
  // the handler, NOT a separate effect, so one tap triggers ONE fetch not two.
  function selectBucket(next: MasteryBucket | null): void {
    setBucket(next);
    setOffset(0);
  }
  function retry(): void {
    setNonce((n) => n + 1);
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
        setPage(res);
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
    <Card className="km-progress__card">
      {/* P3b trim — the "Vocabulary · 단어 숙달" eyebrow repeated the title;
          the Korean lives on the title itself now. */}
      <div className="km-progress__card-title">
        <Bilingual en="Word mastery" kr="단어 숙달" />
      </div>

      {page === null ? (
        loading ? (
          <div className="km-progress__state">
            <Bilingual en="Loading word mastery…" kr="불러오는 중…" />
          </div>
        ) : error !== null ? (
          <ErrorCard message={error} onRetry={retry} />
        ) : null
      ) : page.summary.total === 0 ? (
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
            summary={page.summary}
            selected={bucket}
            onSelect={selectBucket}
          />
          {page.words.length === 0 ? (
            <p className="km-progress__note">
              <Bilingual
                en="No words in this group."
                kr="이 그룹에는 단어가 없어요."
              />
            </p>
          ) : (
            <ul className="km-mastery__list">
              {page.words.map((w) => (
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
          )}
          {page.total > MASTERY_PAGE ? (
            <div className="km-mastery__pager">
              <Button
                variant="ghost"
                disabled={offset === 0}
                onClick={() => {
                  setOffset((o) => Math.max(0, o - MASTERY_PAGE));
                }}
              >
                <Bilingual en="Prev" kr="이전" compact />
              </Button>
              <span className="km-mastery__pageinfo">
                <Bilingual
                  en={`${String(offset + 1)}–${String(
                    Math.min(offset + MASTERY_PAGE, page.total),
                  )} of ${String(page.total)}`}
                  kr={`${String(page.total)}개 중 ${String(offset + 1)}–${String(
                    Math.min(offset + MASTERY_PAGE, page.total),
                  )}`}
                  compact
                />
              </span>
              <Button
                variant="ghost"
                disabled={offset + MASTERY_PAGE >= page.total}
                onClick={() => {
                  setOffset((o) => o + MASTERY_PAGE);
                }}
              >
                <Bilingual en="Next" kr="다음" compact />
              </Button>
            </div>
          ) : null}
        </>
      )}
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────
// Grammar mastery — designed placeholder (real section lands in P4)
// ─────────────────────────────────────────────────────────────

/**
 * Grammar mastery placeholder — sits beside Word mastery so the page's
 * mastery area already reads as "vocab + grammar". The backing read route
 * (mirroring `/vocab/mastery` over the grammar production-card FSRS state)
 * is a P4 feature; until then this is an intentional coming-soon card,
 * never a blank or broken panel.
 */
function GrammarMasterySection(): JSX.Element {
  return (
    <Card className="km-progress__card">
      {/* P3b trim — the "Grammar · 문법 숙달" eyebrow repeated the title; the
          head row now pairs the bilingual title with the coming-soon pill. */}
      <div className="km-progress__soonhead">
        <div className="km-progress__card-title">
          <Bilingual en="Grammar mastery" kr="문법 숙달" />
        </div>
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
    </Card>
  );
}

export default Progress;
