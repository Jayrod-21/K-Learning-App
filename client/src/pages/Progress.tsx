/**
 * Progress — diagnostic history: per-dimension trend + attempt comparison.
 *
 * Reads `GET /diagnostic/history` (every snapshot, oldest→newest) through
 * `useEndpointOrMock('diagnostic.history', …)` and renders three blocks:
 *
 *   1. **Trend chart** — an inline SVG line chart (no charting dependency;
 *      the codebase charts with hand-rolled SVG/CSS, e.g. SkillsCompare).
 *      One 2px line per dimension (reading/listening/vocab/grammar) plus a
 *      neutral Overall line (mean of the attempt's present dimensions),
 *      y = 0–100 score, x = attempt. Series colors are palette-validated
 *      chart tokens (see Progress.css) so the chart reads in both themes and
 *      under color-vision deficiency; a legend + per-attempt readout +
 *      history table mean no value is ever color- or hover-gated.
 *   2. **Attempt vs attempt** — two pickers (defaulting to previous vs
 *      latest) and a per-dimension delta table with signed ▲/▼ arrows, so
 *      direction never rides on color alone.
 *   3. **All attempts table** — the chart's accessible twin; every plotted
 *      value is readable without a pointer.
 *
 * Empty states: 0 snapshots → invitation card linking to /diagnostic;
 * 1 snapshot → markers only (a one-point "trend" draws no line) + a note,
 * comparison hidden. Neither crashes — geometry guards `n === 1` division.
 *
 * Threat model:
 *   - **Rendered text is escaped.** Every server string (labels, kr, goals)
 *     renders as React children — a malicious payload becomes literal text.
 *     No `dangerouslySetInnerHTML`; SVG text nodes are React children too.
 *   - **Read-only surface.** The page issues a single authenticated GET; no
 *     mutation, no client-supplied identifiers (no IDOR surface). Server
 *     scopes the query to the session user.
 *   - **Mock fallback honesty.** The mock loader resolves an EMPTY history
 *     (mirroring the Diagnostic screen's empty fixture) so a real-endpoint
 *     failure can never paint fabricated progress; when the real call fails
 *     and the fallback is empty we show the error card, not a fake state.
 */
import { useEffect, useState, type JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card } from '../components/Card';
import { Button } from '../components/Button';
import { Eyebrow } from '../components/Eyebrow';
import { Icon } from '../components/Icon';
import { MockBadge } from '../components/MockBadge';
import { ErrorCard } from '../components/ErrorCard';
import { useEndpointOrMock } from '../hooks/useEndpointOrMock';
import { getHistory } from '../services/diagnostic';
import { fetchMastery } from '../services/vocab';
import { ApiError } from '../services/api';
import { mockDelay } from '../data/mocks/_delay';
import type {
  DiagnosticHistoryResponse,
  DiagnosticHistorySnapshot,
  MasteryBucket,
  MasteryPage,
  MasterySummary,
} from '../types/domain';
import './Progress.css';

// ─────────────────────────────────────────────────────────────
// Series manifest + score helpers
// ─────────────────────────────────────────────────────────────

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
      {hist.isMock && fatalError === null ? <MockBadge /> : null}

      <Eyebrow>Diagnostic history · 진단 기록</Eyebrow>
      <h1 id="progress-title" className="kr-display km-progress__title">
        Progress
      </h1>

      {hist.loading ? (
        <div className="km-progress__state" role="status">
          Loading progress…
        </div>
      ) : null}

      {!hist.loading && fatalError !== null ? (
        <ErrorCard message={fatalError.message} onRetry={hist.refetch} />
      ) : null}

      {!hist.loading && fatalError === null && snapshots !== null ? (
        snapshots.length === 0 ? (
          <EmptyBlock />
        ) : (
          <HistoryBlocks snapshots={snapshots} />
        )
      ) : null}

      <WordMasterySection />
    </section>
  );
}

function EmptyBlock(): JSX.Element {
  const navigate = useNavigate();
  return (
    <Card className="km-progress__card">
      <Eyebrow>No attempts yet</Eyebrow>
      <div className="km-progress__card-title">Your trend starts here</div>
      <p className="km-progress__note">
        Finish a diagnostic and every attempt lands on this page — take a
        second one and the trend lines appear.
      </p>
      <Button
        variant="gold"
        onClick={() => {
          navigate('/diagnostic');
        }}
        trailingIcon={<Icon name="arrow-right" size={14} />}
      >
        Take the diagnostic
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
      <Card className="km-progress__card">
        <Eyebrow>Score over attempts · 0–100</Eyebrow>
        <div className="km-progress__card-title">Trend</div>
        <TrendChart snapshots={snapshots} />
        {n === 1 ? (
          <p className="km-progress__note">
            One attempt so far — retake the diagnostic and the trend lines
            appear.
          </p>
        ) : null}
      </Card>

      {n >= 2 ? <CompareBlock snapshots={snapshots} /> : null}

      <Card className="km-progress__card">
        <Eyebrow>Every attempt · oldest first</Eyebrow>
        <div className="km-progress__card-title">All attempts</div>
        <AttemptsTable snapshots={snapshots} />
      </Card>
    </>
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
          Attempt {readoutIdx + 1}
          {readoutSnap !== undefined ? ` · ${formatDay(readoutSnap.capturedAt)}` : ''}
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
                  {series.label}
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
            {series.label} · {series.kr}
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
// Attempt vs attempt
// ─────────────────────────────────────────────────────────────

function CompareBlock({ snapshots }: HistoryProps): JSX.Element {
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
    // Unreachable: the caller renders CompareBlock only when n >= 2 and both
    // indices are clamped to [0, n-1]. Guarded for noUncheckedIndexedAccess.
    return <></>;
  }

  return (
    <Card className="km-progress__card">
      <Eyebrow>Attempt vs attempt</Eyebrow>
      <div className="km-progress__card-title">Comparison</div>

      <div className="km-progress__selects">
        <label className="km-progress__select-label">
          From
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
          To
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
            Score change from attempt {fromIdx + 1} to attempt {toIdx + 1}
          </caption>
          <thead>
            <tr>
              <th scope="col">Skill</th>
              <th scope="col" className="km-progress__num">
                Attempt {fromIdx + 1}
              </th>
              <th scope="col" className="km-progress__num">
                Attempt {toIdx + 1}
              </th>
              <th scope="col" className="km-progress__num">
                Change
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
                    {series.label}
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
    </Card>
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
// All attempts table (the chart's accessible twin)
// ─────────────────────────────────────────────────────────────

function AttemptsTable({ snapshots }: HistoryProps): JSX.Element {
  return (
    <div className="km-progress__tablewrap">
      <table className="km-progress__table">
        <caption>All diagnostic attempts, oldest first</caption>
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Date</th>
            {SERIES.map((series) => (
              <th scope="col" key={series.key} className="km-progress__num">
                {series.label}
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

const BUCKET_META: Record<MasteryBucket, { label: string; cls: string }> = {
  new: { label: 'New', cls: 'is-new' },
  learning: { label: 'Learning', cls: 'is-learning' },
  reviewing: { label: 'Reviewing', cls: 'is-reviewing' },
  mastered: { label: 'Mastered', cls: 'is-mastered' },
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
            {BUCKET_META[b].label} <b>{summary[b]}</b>
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
          err instanceof ApiError ? err.message : 'Could not load word mastery.',
        );
        setLoading(false);
      });
    return () => {
      ctrl.abort();
    };
  }, [bucket, offset, nonce]);

  return (
    <Card className="km-progress__card">
      <Eyebrow>Vocabulary · 단어 숙달</Eyebrow>
      <div className="km-progress__card-title">Word mastery</div>

      {page === null ? (
        loading ? (
          <div className="km-progress__state">Loading word mastery…</div>
        ) : error !== null ? (
          <ErrorCard message={error} onRetry={retry} />
        ) : null
      ) : page.summary.total === 0 ? (
        <p className="km-progress__note">
          No vocab cards yet — tap a word in Listen and add it to your review
          deck, and its mastery shows up here.
        </p>
      ) : (
        <>
          {error !== null ? (
            <p className="km-mastery__stale" role="alert">
              Couldn’t refresh — showing the last loaded mastery.{' '}
              <button
                type="button"
                className="km-mastery__retry"
                onClick={retry}
              >
                Retry
              </button>
            </p>
          ) : null}
          <MasteryBar
            summary={page.summary}
            selected={bucket}
            onSelect={selectBucket}
          />
          {page.words.length === 0 ? (
            <p className="km-progress__note">No words in this group.</p>
          ) : (
            <ul className="km-mastery__list">
              {page.words.map((w) => (
                <li key={w.id} className="km-mastery__row">
                  <span className="kr km-mastery__kr">{w.korean}</span>
                  <span className="km-mastery__en">{w.english ?? ''}</span>
                  <span
                    className={`km-mastery__badge ${BUCKET_META[w.bucket].cls}`}
                  >
                    {BUCKET_META[w.bucket].label}
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
                Prev
              </Button>
              <span className="km-mastery__pageinfo">
                {String(offset + 1)}–
                {String(Math.min(offset + MASTERY_PAGE, page.total))} of{' '}
                {String(page.total)}
              </span>
              <Button
                variant="ghost"
                disabled={offset + MASTERY_PAGE >= page.total}
                onClick={() => {
                  setOffset((o) => o + MASTERY_PAGE);
                }}
              >
                Next
              </Button>
            </div>
          ) : null}
        </>
      )}
    </Card>
  );
}

export default Progress;
