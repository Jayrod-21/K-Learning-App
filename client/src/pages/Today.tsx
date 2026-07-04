/**
 * Today screen — daily plan dashboard.
 *
 * Layout (per design README §2):
 *   1. Topbar: date eyebrow + 오늘 · Today serif title.
 *   2. Skills snapshot card (compact SkillsCompare).
 *   3. Review queue accent card (vermilion border, live "{n} cards due", FSRS meta).
 *   4. Three TaskCards in responsive grid — Reading / Listening / Writing.
 *      Listening = "Largest gap" (gold). Writing = "Register drill" (red/indigo).
 *
 * Data:
 *   useEndpointOrMock('today', loadTodayMock, { realFn: fetchToday })                        → TodayPlan
 *   useEndpointOrMock('today.snapshot', loadDiagnosticSnapshotMock, { realFn: fetchLatestSnapshot }) → DiagnosticSnapshot
 *
 * Two fetches because Today composes the plan AND the snapshot; pulling them
 * separately matches the Pass 4/5 server split (`/plan/today` vs
 * `/diagnostic/latest`) and lets each fail independently in the UI.
 *
 * Threat model:
 *   Fixture text rendered as React children → escaped by React. Pass 3+ wire
 *   must keep this contract (text fields, not HTML strings).
 */
import { useNavigate } from 'react-router-dom';
import type { JSX } from 'react';
import { Topbar } from '../components/Topbar';
import { Card } from '../components/Card';
import { Pill } from '../components/Pill';
import { Icon } from '../components/Icon';
import { TaskCard } from '../components/TaskCard';
import { SkillsCompare } from '../components/SkillsCompare';
import type {
  SkillReference,
  SkillRow,
} from '../components/SkillsCompare';
import { MockBadge } from '../components/MockBadge';
import { Button } from '../components/Button';
import { ErrorCard } from '../components/ErrorCard';
import { useEndpointOrMock } from '../hooks/useEndpointOrMock';
import { loadTodayMock } from '../data/mocks/today';
import { fetchToday } from '../services/plan';
import { fetchLatestSnapshot } from '../services/diagnostic';
import { loadDiagnosticSnapshotMock } from '../data/mocks/diagnostic';
import type {
  DiagnosticSnapshot,
  TodayPlan,
  TodayTask,
} from '../types/domain';

/** Format the current date in the design's eyebrow style ("Monday, May 28"). */
function formatDateEyebrow(d: Date): string {
  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

/** Map a domain snapshot to the SkillsCompare props shape. */
function toSkillRows(snap: DiagnosticSnapshot): ReadonlyArray<SkillRow> {
  return snap.dimensions.map((d) => ({
    key: d.key,
    label: d.label,
    kr: d.kr,
    score: d.score,
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

/**
 * Tone for a Today task tile. The largest-gap modality is painted gold (the
 * design's emphasis); Writing keeps its standing red "register drill" identity
 * when it is NOT the gap; everything else is neutral.
 */
function tileTone(
  tag: TodayTask['tag'],
  gap: TodayTask['tag'],
): 'default' | 'gold' | 'red' {
  if (tag === gap) return 'gold';
  if (tag === 'Writing') return 'red';
  return 'default';
}

/**
 * Pill copy for a Today task tile. The gap tile reads "Largest gap"; Writing's
 * standing identity is "Register drill". A non-gap Reading/Listening tile has
 * no pill. `gap` takes precedence over Writing's default so a writing-is-weakest
 * day shows "Largest gap", not "Register drill".
 */
function tileTag(
  tag: TodayTask['tag'],
  gap: TodayTask['tag'],
): string | undefined {
  if (tag === gap) return 'Largest gap';
  if (tag === 'Writing') return 'Register drill';
  return undefined;
}

/** One Today task tile, paired with its Korean tag, skill label, and route. */
interface TaskTile {
  task: TodayTask;
  krTag: string;
  skill: string;
  nav: string;
}

/** Render a quick skeleton-shaped card while data loads. */
function SkeletonCard(): JSX.Element {
  // Static height + dimmed paint mimics card-shaped loading per CLAUDE plan.
  // Empty fragment satisfies Card's required `children` without rendering text.
  return (
    <Card
      variant="default"
      aria-busy="true"
      style={{ minHeight: 120, opacity: 0.55 }}
    >
      <></>
    </Card>
  );
}

export function Today(): JSX.Element {
  const navigate = useNavigate();
  // Both fetches are live as of Pass 5: the plan via `GET /plan/today` and the
  // diagnostic snapshot via `GET /diagnostic/latest`. Each falls back to its
  // mock loader if the real endpoint rejects (the hook owns that swap), and
  // each fails independently in the UI.
  const today = useEndpointOrMock<TodayPlan>('today', loadTodayMock, {
    realFn: () => fetchToday(),
  });
  const diag = useEndpointOrMock<DiagnosticSnapshot>(
    'today.snapshot',
    loadDiagnosticSnapshotMock,
    { realFn: () => fetchLatestSnapshot() },
  );

  const dateStr = formatDateEyebrow(new Date());

  // Retry routes through the hook's `refetch()` rather than a brutal
  // `window.location.reload()`. Each ErrorCard targets the failing fetch
  // alone — a diagnostic-snapshot failure no longer reloads the entire
  // app to recover the today plan.
  const retryToday = today.refetch;
  const retryDiag = diag.refetch;

  // MockBadge tracks realFn-backed sources (the unified Pass-3 semantics). As
  // of Pass 5 both the plan AND the diagnostic snapshot are realFn-backed, so
  // either falling back to its mock should trip the dev-only 🅂 badge.
  const isMock = today.isMock || diag.isMock;

  // Build the visible task tiles. Tasks the server couldn't fill (empty corpus)
  // arrive null and are simply omitted — no faked card. `largestGap` defaults
  // to Listening (the design's emphasis) until the user has a diagnostic run.
  const gapTag: TodayTask['tag'] = today.data?.largestGap ?? 'Listening';
  const taskTiles: TaskTile[] = [];
  if (today.data) {
    const candidates: Array<{ task: TodayTask | null } & Omit<TaskTile, 'task'>> = [
      { task: today.data.reading, krTag: '읽기', skill: 'Reading', nav: '/reading' },
      { task: today.data.listening, krTag: '듣기', skill: 'Listening', nav: '/reading' },
      { task: today.data.writing, krTag: '쓰기', skill: 'Writing', nav: '/writing' },
    ];
    for (const c of candidates) {
      if (c.task) taskTiles.push({ task: c.task, krTag: c.krTag, skill: c.skill, nav: c.nav });
    }
  }

  return (
    <section
      className="screen km-today"
      aria-labelledby="today-title"
      style={{ position: 'relative', paddingBottom: 32 }}
    >
      {isMock ? <MockBadge /> : null}

      <Topbar
        krTitle={<span id="today-title">오늘 · Today</span>}
        eyebrow={dateStr}
      />

      {/* Skills snapshot ─────────────────────────────────────── */}
      <section style={{ marginBottom: 16 }}>
        {diag.loading ? (
          <SkeletonCard />
        ) : diag.data && diag.data.dimensions.length > 0 ? (
          <Card variant="default" style={{ padding: '20px 22px' }}>
            <SkillsCompare
              variant="compact"
              skills={toSkillRows(diag.data)}
              references={toSkillRefs(diag.data)}
              defaultRefId={diag.data.defaultRef}
            />
          </Card>
        ) : diag.data ? (
          // Empty snapshot — no prior diagnostic run. Nudge the user to
          // take one rather than rendering an empty SkillsCompare shell.
          <Card variant="flat" style={{ padding: '18px 22px' }}>
            <div className="km-eyebrow" style={{ marginBottom: 6 }}>
              진단평가 · Diagnostic
            </div>
            <div style={{ fontSize: 14, color: 'var(--paper-dim)', marginBottom: 12 }}>
              Take the 12-minute diagnostic to see your skills snapshot.
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                navigate('/diagnostic');
              }}
            >
              Start diagnostic
            </Button>
          </Card>
        ) : (
          <ErrorCard
            message="Skills snapshot is unavailable."
            onRetry={retryDiag}
          />
        )}
      </section>

      {/* Review queue CTA ────────────────────────────────────── */}
      {today.loading ? (
        <div style={{ marginBottom: 16 }}>
          <SkeletonCard />
        </div>
      ) : today.data ? (
        <button
          type="button"
          onClick={() => {
            navigate('/review');
          }}
          className="km-today__queue focusring"
          aria-label={`Open review — ${String(today.data.reviewCount)} cards due`}
        >
          <div>
            <Pill tone="gold">Due now</Pill>
            <div className="km-today__queueCount">
              {today.data.reviewCount} cards due
            </div>
            {/* No fabricated grammar/vocab split or minute estimate here —
                /plan/today returns only `dueCount`, so any breakdown would
                contradict the live count above (it would always read the
                fixture's "24"). Keep the meta honest to the data we have. */}
            <div className="km-today__queueMeta">
              FSRS scheduling · due for review
            </div>
          </div>
          <Icon name="arrow-right" size={22} />
        </button>
      ) : (
        <div style={{ marginBottom: 16 }}>
          <ErrorCard
            message="Today's plan is unavailable."
            onRetry={retryToday}
          />
        </div>
      )}

      {/* Three task cards ────────────────────────────────────── */}
      {taskTiles.length > 0 ? (
        <div className="km-today__grid" role="list" aria-label="Today's tasks">
          {taskTiles.map((tile) => (
            <div role="listitem" key={tile.task.tag}>
              <TaskCard
                skill={`${tile.skill} · ${tile.task.level}`}
                krTag={tile.krTag}
                title={tile.task.title}
                mins={tile.task.mins}
                tone={tileTone(tile.task.tag, gapTag)}
                tag={tileTag(tile.task.tag, gapTag)}
                onClick={() => {
                  navigate(tile.nav);
                }}
              />
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

export default Today;
