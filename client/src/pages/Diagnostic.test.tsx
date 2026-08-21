/**
 * Diagnostic (Pass 5 — server-graded) — covers:
 *   - loading → mode resolution (intro vs results from the latest snapshot)
 *   - intro → taking start (startDiagnostic)
 *   - server-graded answer reveal (no client-held answer; reveal comes from
 *     the /answer response's `correctAnswer`)
 *   - B-006 decoupling: the reveal renders as soon as `/answer` resolves,
 *     even while the `/next` prefetch is still in flight — grading is never
 *     blocked on item generation
 *   - advance to the prefetched next item, then finish → done → results with
 *     the server-returned snapshot
 *   - a11y: progressbar ARIA, reveal block ids
 *   - error path: a failed start surfaces an ErrorCard
 *
 * `useEndpointOrMock` is module-mocked so the snapshot fetch is deterministic.
 * The diagnostic service is module-mocked so the Taking flow's network calls
 * are controlled — this is where we assert the screen never self-grades.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { JSX } from 'react';
import { ToastProvider } from '../components/ToastProvider';
import {
  DIAGNOSTIC_SNAPSHOT_FIXTURE,
  DIAGNOSTIC_SNAPSHOT_POPULATED_FIXTURE,
} from '../data/mocks/diagnostic';
import { ApiError } from '../services/api';
import type {
  DiagnosticAnswerResponse,
  DiagnosticLiveItem,
  DiagnosticNextResponse,
  DiagnosticSnapshot,
  DiagnosticStartResponse,
} from '../types/domain';

interface HookResult<T> {
  data: T | null;
  loading: boolean;
  error: ApiError | null;
  isMock: boolean;
  refetch?: () => void;
}

const refetchSpy = vi.fn();

const hookState: { snapshot: HookResult<DiagnosticSnapshot> } = {
  snapshot: {
    data: null,
    loading: true,
    error: null,
    isMock: false,
    refetch: refetchSpy,
  },
};

vi.mock('../hooks/useEndpointOrMock', () => ({
  useEndpointOrMock: (key: string) => {
    if (key === 'diagnostic.latest') return hookState.snapshot;
    throw new Error(`unexpected key: ${key}`);
  },
}));

// Service mock — every Taking-flow call routes through here. `vi.hoisted` is
// required because `vi.mock` is hoisted above imports; the shared mock fns must
// be hoisted too, otherwise the factory hits TDZ (the Today.test.tsx pattern).
const svc = vi.hoisted(() => ({
  startDiagnostic: vi.fn<() => Promise<DiagnosticStartResponse>>(),
  answerDiagnostic:
    vi.fn<(runId: number, body: unknown) => Promise<DiagnosticAnswerResponse>>(),
  nextDiagnostic: vi.fn<(runId: number) => Promise<DiagnosticNextResponse>>(),
  finishDiagnostic: vi.fn<() => Promise<{ snapshot: DiagnosticSnapshot }>>(),
}));

vi.mock('../services/diagnostic', () => ({
  startDiagnostic: () => svc.startDiagnostic(),
  answerDiagnostic: (runId: number, body: unknown) =>
    svc.answerDiagnostic(runId, body),
  nextDiagnostic: (runId: number) => svc.nextDiagnostic(runId),
  finishDiagnostic: () => svc.finishDiagnostic(),
  // Never actually invoked — useEndpointOrMock is mocked and ignores realFn —
  // but stubbed so the module's named export exists for the screen's import.
  fetchLatestSnapshot: () => Promise.reject(new Error('not used in tests')),
}));

const { startDiagnostic, answerDiagnostic, nextDiagnostic, finishDiagnostic } = svc;

import Diagnostic from './Diagnostic';

const EMPTY_SNAPSHOT: DiagnosticSnapshot = {
  dimensions: [],
  references: [{ id: 'L4', label: 'TOPIK 4', kr: '4급', value: 55 }],
  defaultRef: 'L4',
  goals: [],
};

const POPULATED_SNAPSHOT: DiagnosticSnapshot = {
  // F-011: reading carries a real confidence band; grammar carries the
  // degenerate low == score == high fallback (renders no band).
  dimensions: [
    {
      key: 'reading',
      label: 'Reading',
      kr: '읽기',
      score: 62,
      scoreLow: 54,
      scoreHigh: 70,
      note: 'OK',
    },
    {
      key: 'grammar',
      label: 'Grammar',
      kr: '문법',
      score: 44,
      scoreLow: 44,
      scoreHigh: 44,
      note: 'Gap',
    },
  ],
  references: [
    { id: 'L4', label: 'TOPIK 4', kr: '4급', value: 55 },
    { id: 'native', label: 'Native', kr: '원어민', value: 100 },
  ],
  defaultRef: 'L4',
  goals: ['Drill -더라도 daily.'],
};

// F-002: a beginner placement — the ladder now reaches below L3, so the
// snapshot can carry TOPIK 1/2 reference lines and default to one of them.
// Typing this literal as DiagnosticSnapshot pins the widened
// `DiagnosticReference['id']` union at compile time.
const BEGINNER_SNAPSHOT: DiagnosticSnapshot = {
  dimensions: [
    {
      key: 'reading',
      label: 'Reading',
      kr: '읽기',
      score: 22,
      scoreLow: 12,
      scoreHigh: 32,
      note: 'Start with short sentences.',
    },
    {
      key: 'vocab',
      label: 'Vocabulary',
      kr: '어휘',
      score: 14,
      scoreLow: 14,
      scoreHigh: 14,
      note: 'Core 800 words first.',
    },
  ],
  references: [
    { id: 'L1', label: 'TOPIK 1', kr: '1급', value: 10 },
    { id: 'L2', label: 'TOPIK 2', kr: '2급', value: 25 },
    { id: 'L3', label: 'TOPIK 3', kr: '3급', value: 40 },
  ],
  defaultRef: 'L2',
  goals: ['Finish the core 800 vocabulary list.'],
};

const ITEM_1: DiagnosticLiveItem = {
  responseId: 101,
  ordinal: 1,
  section: 'vocab',
  level: 'L3',
  kind: 'cloze',
  prompt: '회사에서 새로운 정책을 ( ) 했다.',
  choices: [
    { id: 'a', kr: '발표', en: 'announce' },
    { id: 'b', kr: '발견', en: 'discover' },
  ],
};

const ITEM_2: DiagnosticLiveItem = {
  responseId: 102,
  ordinal: 2,
  section: 'grammar',
  level: 'L4',
  kind: 'pattern',
  prompt: '비가 ( ) 우산을 가지고 가세요.',
  choices: [
    { id: 'a', kr: '오니까', en: 'because it rains' },
    { id: 'b', kr: '올 텐데', en: 'will likely rain' },
  ],
};

// F-002: live items can now be served at the new beginner bands. Typing these
// literals as DiagnosticLiveItem pins the widened `DiagnosticLevel` union.
const ITEM_L1: DiagnosticLiveItem = {
  responseId: 201,
  ordinal: 1,
  section: 'vocab',
  level: 'L1',
  kind: 'cloze',
  prompt: '저는 물을 ( ).',
  choices: [
    { id: 'a', kr: '마셔요', en: 'drink' },
    { id: 'b', kr: '읽어요', en: 'read' },
  ],
};

const ITEM_L2: DiagnosticLiveItem = {
  responseId: 202,
  ordinal: 2,
  section: 'grammar',
  level: 'L2',
  kind: 'pattern',
  prompt: '주말에 친구를 ( ) 영화를 봤어요.',
  choices: [
    { id: 'a', kr: '만나서', en: 'met and then' },
    { id: 'b', kr: '만나면', en: 'if I meet' },
  ],
};

function renderWithRouter(): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <Diagnostic />
      </ToastProvider>
    </MemoryRouter>,
  );
}

/**
 * Lands at `/chat` after an "Ask about this" click (F-020) and prints the
 * router state the navigation carried, so a test can assert the actual seed
 * payload (the Mistakes.test.tsx probe pattern).
 */
function ChatSeedProbe(): JSX.Element {
  const location = useLocation();
  const state = location.state as { seedText?: string; mode?: string } | null;
  return (
    <div data-testid="chat-seed">
      {state?.seedText ?? 'no-seed'}
      {state?.mode !== undefined ? ` mode=${state.mode}` : ''}
    </div>
  );
}

/** Render Diagnostic with a `/chat` probe route so seed navigations land. */
function renderWithChatProbe(): void {
  render(
    <MemoryRouter initialEntries={['/diagnostic']}>
      <ToastProvider>
        <Routes>
          <Route path="/diagnostic" element={<Diagnostic />} />
          <Route path="/chat" element={<ChatSeedProbe />} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  );
}

/**
 * Boot a fresh single-item run for the F-020 seed tests: intro → item, then
 * grade with `result` (done:true, so no /next prefetch to satisfy). Pass the
 * choice index to pick, or null to Skip.
 */
async function driveToReveal(
  user: ReturnType<typeof userEvent.setup>,
  item: DiagnosticLiveItem,
  result: { correct: boolean; correctAnswer: string; explain: string },
  pickIndex: number | null,
): Promise<void> {
  hookState.snapshot = {
    data: EMPTY_SNAPSHOT,
    loading: false,
    error: null,
    isMock: true,
  };
  startDiagnostic.mockResolvedValue({
    runId: 31,
    item,
    progress: { ordinal: 1, total: 1 },
  });
  answerDiagnostic.mockResolvedValueOnce({
    result,
    done: true,
    progress: { ordinal: 1, total: 1 },
  });

  renderWithChatProbe();
  await user.click(screen.getByRole('button', { name: /begin test/i }));
  await screen.findByText(item.prompt);
  if (pickIndex !== null) {
    await user.click(screen.getAllByRole('radio')[pickIndex]!);
    await user.click(screen.getByRole('button', { name: /submit/i }));
  } else {
    await user.click(screen.getByRole('button', { name: /skip/i }));
  }
  await screen.findByRole('button', { name: 'Ask about this' });
}

describe('Diagnostic', () => {
  beforeEach(() => {
    hookState.snapshot = {
      data: null,
      loading: true,
      error: null,
      isMock: false,
      refetch: refetchSpy,
    };
    refetchSpy.mockReset();
    startDiagnostic.mockReset();
    answerDiagnostic.mockReset();
    nextDiagnostic.mockReset();
    finishDiagnostic.mockReset();
  });

  it('shows the loading state until the snapshot fetch resolves', () => {
    renderWithRouter();
    expect(screen.getByRole('status')).toHaveTextContent(/loading diagnostic/i);
  });

  it('lands on Intro on a fresh boot (empty snapshot dimensions)', () => {
    hookState.snapshot = {
      data: EMPTY_SNAPSHOT,
      loading: false,
      error: null,
      isMock: true,
    };
    renderWithRouter();
    const headings = screen.getAllByText('진단평가');
    expect(headings.length).toBeGreaterThan(0);
    expect(
      screen.getByRole('button', { name: /begin test/i }),
    ).toBeInTheDocument();
    // Results-only chrome is NOT in the DOM yet.
    expect(screen.queryByText('Skills snapshot')).not.toBeInTheDocument();
  });

  it('F-128: the root carries the Seoul rain-sheen and Intro adopts the CityCard/hub-header kit', () => {
    hookState.snapshot = {
      data: EMPTY_SNAPSHOT,
      loading: false,
      error: null,
      isMock: true,
    };
    const { container } = renderWithRouter();
    // Device #8 ambient overlay on the page root.
    expect(container.querySelector('.km-rain-sheen')).not.toBeNull();
    // Devices #1/#2 — the section list is a CityCard signboard/hanji-paper
    // surface with a leading DancheongRail, not the old plain Card.
    expect(container.querySelector('.km-diagnostic__sections.km-citycard')).not.toBeNull();
    expect(
      container.querySelector('.km-diagnostic__sections .km-dancheong-rail'),
    ).not.toBeNull();
    // Devices #4/#2 — the shared PageHubHeader recipe (skyline + rail
    // divider) replaced the old bare `<h1>` + eyebrow pair.
    expect(container.querySelector('.km-hubheader')).not.toBeNull();
    // The old custom header class is gone.
    expect(container.querySelector('.km-diagnostic__display')).toBeNull();
  });

  it('F-011: the intro advertises the real 22-item / 6-section test shape (diagnostic-upgrade Phase B)', () => {
    // The server serves 4 each of reading/listening/vocab/grammar/hanja plus
    // 2 writing (WEIGHTS in server/src/routes/diagnostic.ts, diagnostic-
    // upgrade Phase B) → a 22-item schedule, and the taking-screen progress
    // bar counts to the server's total. The intro's promise must match — the
    // old "8 items / 2 items / 12 min" copy shipped one screen before the
    // progress bar (fixpass R3 B1). This pins intro ↔ server-shape sync.
    hookState.snapshot = {
      data: EMPTY_SNAPSHOT,
      loading: false,
      error: null,
      isMock: true,
    };
    renderWithRouter();
    // Eyebrow: "진단평가 · 20 min · 22 items".
    expect(screen.getByText(/20 min · 22 items/)).toBeInTheDocument();
    // Five section rows promise 4 items each; writing promises 2.
    expect(screen.getAllByText('4 items')).toHaveLength(5);
    expect(screen.getByText('2 items')).toBeInTheDocument();
    // The stale pre-F-011 / pre-Phase-B shapes must never come back.
    expect(screen.queryByText(/8 items/)).not.toBeInTheDocument();
    expect(screen.queryByText(/20 items/)).not.toBeInTheDocument();
    expect(screen.queryByText(/12 min/)).not.toBeInTheDocument();
  });

  it('P3b: the intro renders bilingual chrome — section labels, counts, no doubled title', () => {
    hookState.snapshot = {
      data: EMPTY_SNAPSHOT,
      loading: false,
      error: null,
      isMock: true,
    };
    renderWithRouter();

    // INTRO_SECTIONS render both language segments via <Bilingual/> (the
    // baked "kr · en" span pair is gone). Six sections since diagnostic-
    // upgrade Phase B (writing joins hanja/reading/listening/vocab/grammar).
    for (const kr of ['읽기', '듣기', '어휘', '문법', '한자', '쓰기']) {
      expect(screen.getByText(kr)).toBeInTheDocument();
    }
    for (const en of [
      'Reading',
      'Listening',
      'Vocabulary',
      'Grammar',
      'Hanja',
      'Writing',
    ]) {
      expect(screen.getByText(en)).toBeInTheDocument();
    }
    // The per-section count carries Korean too. The counts render compact
    // (one language visually), so each row holds the Korean twice: the
    // visible primary + the sr-only bilingual reading. Five rows at 4문항
    // (reading/listening/vocab/grammar/hanja) × 2 = 10; writing's own 2문항
    // row is asserted separately since its count differs.
    expect(screen.getAllByText('4문항')).toHaveLength(10);
    expect(screen.getAllByText('2문항')).toHaveLength(2);
    // Verbage trim: the eyebrow no longer repeats the title's 진단평가 —
    // it appears exactly once, in the h1.
    expect(screen.getAllByText('진단평가')).toHaveLength(1);
    // The bilingual CTA carries its Korean half.
    expect(screen.getByText('시험 시작')).toBeInTheDocument();
  });

  it('lands on Results when the snapshot has prior dimensions', () => {
    hookState.snapshot = {
      data: POPULATED_SNAPSHOT,
      loading: false,
      error: null,
      isMock: false,
    };
    renderWithRouter();
    expect(screen.getByText('Skills snapshot')).toBeInTheDocument();
    // P3b: the results chrome is bilingual (Korean segments present).
    expect(screen.getByText('실력 요약')).toBeInTheDocument();
    // P3b consistency: the sub-line names the band 신뢰 구간 — the same term
    // as the SkillsCompare legend on this screen (bare 띠 is retired).
    expect(
      screen.getByText(/신뢰 구간은 각 결과의 신뢰도를 보여 줘요/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/띠는/)).not.toBeInTheDocument();
    // F-143: retake is the only surviving CTA (see the dedicated test below
    // for the full "Begin today's plan" / goals-card removal assertions).
    expect(
      screen.getByRole('button', { name: /re-test diagnostic/i }),
    ).toBeInTheDocument();
  });

  it('F-143: removes the "Begin today\'s plan" CTA and the "gaps / next steps" card from Results', () => {
    hookState.snapshot = {
      data: POPULATED_SNAPSHOT,
      loading: false,
      error: null,
      isMock: false,
    };
    renderWithRouter();
    // The results screen still renders (scores, section breakdown intact)…
    expect(screen.getByText('Skills snapshot')).toBeInTheDocument();
    expect(screen.getByText('실력 요약')).toBeInTheDocument();
    // …but neither removed block renders anywhere on the screen.
    expect(
      screen.queryByRole('button', { name: /begin today/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/begin today.s plan/i)).not.toBeInTheDocument();
    expect(screen.queryByText('오늘의 계획 시작')).not.toBeInTheDocument();
    expect(screen.queryByText('다음 단계')).not.toBeInTheDocument();
    expect(screen.queryByText('Next steps')).not.toBeInTheDocument();
    expect(screen.queryByText('Derived from your gaps')).not.toBeInTheDocument();
    expect(screen.queryByText('약점 기반')).not.toBeInTheDocument();
    // The POPULATED_SNAPSHOT fixture's actual goal text must not leak through.
    expect(screen.queryByText('Drill -더라도 daily.')).not.toBeInTheDocument();
    // The retake action is the only remaining CTA.
    expect(
      screen.getByRole('button', { name: /re-test diagnostic/i }),
    ).toBeInTheDocument();
  });

  it('F-128: Results adopts the hub-header + CityCard kit', () => {
    hookState.snapshot = {
      data: POPULATED_SNAPSHOT,
      loading: false,
      error: null,
      isMock: false,
    };
    const { container } = renderWithRouter();
    // Devices #4/#2 — the shared PageHubHeader recipe.
    expect(container.querySelector('.km-hubheader')).not.toBeNull();
    // Devices #1/#2 — the skills card is a CityCard signboard/hanji-paper
    // surface with a leading DancheongRail, not the old plain Card.
    expect(
      container.querySelector('.km-diagnostic__skills-card.km-citycard'),
    ).not.toBeNull();
    expect(
      container.querySelector('.km-diagnostic__skills-card .km-dancheong-rail'),
    ).not.toBeNull();
    expect(container.querySelector('.km-diagnostic__results-title')).toBeNull();
  });

  it('F-002: results render TOPIK 1 / TOPIK 2 reference options for a beginner placement', () => {
    hookState.snapshot = {
      data: BEGINNER_SNAPSHOT,
      loading: false,
      error: null,
      isMock: false,
    };
    renderWithRouter();
    // Both new beginner reference lines are pickable…
    expect(screen.getByRole('radio', { name: '1급 · TOPIK 1' })).toBeInTheDocument();
    // …and the snapshot's defaultRef ('L2') is honoured as the active pick.
    expect(screen.getByRole('radio', { name: '2급 · TOPIK 2' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    // The full-mode legend (and now the bilingual pick itself) echoes the
    // active beginner ref's 급 shorthand.
    expect(screen.getAllByText(/2급/).length).toBeGreaterThan(0);
  });

  it('F-002: the mock snapshot fixtures carry the full L1–native reference ladder', () => {
    // Pins the fixture itself: if L1/L2 are ever dropped from the mock
    // references, the mock-mode Results/Today screens silently lose the
    // beginner ladder — fail here instead.
    for (const fixture of [
      DIAGNOSTIC_SNAPSHOT_FIXTURE,
      DIAGNOSTIC_SNAPSHOT_POPULATED_FIXTURE,
    ]) {
      expect(fixture.references).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'L1', label: 'TOPIK 1', kr: '1급' }),
          expect.objectContaining({ id: 'L2', label: 'TOPIK 2', kr: '2급' }),
        ]),
      );
      // The ladder stays ordered: L1 < L2 < L3 reference values.
      const value = (id: string): number =>
        fixture.references.find((r) => r.id === id)?.value ?? NaN;
      expect(value('L1')).toBeLessThan(value('L2'));
      expect(value('L2')).toBeLessThan(value('L3'));
    }
  });

  it('F-002: the taking flow serves and labels items at the new L1/L2 bands', async () => {
    hookState.snapshot = {
      data: EMPTY_SNAPSHOT,
      loading: false,
      error: null,
      isMock: true,
    };
    startDiagnostic.mockResolvedValue({
      runId: 9,
      item: ITEM_L1,
      progress: { ordinal: 1, total: 2 },
    });
    answerDiagnostic.mockResolvedValueOnce({
      result: { correct: true, correctAnswer: 'a', explain: '마시다 = to drink.' },
      done: false,
      progress: { ordinal: 1, total: 2 },
    });
    nextDiagnostic.mockResolvedValueOnce({
      next: ITEM_L2,
      progress: { ordinal: 2, total: 2 },
    });

    const user = userEvent.setup();
    renderWithRouter();
    await user.click(screen.getByRole('button', { name: /begin test/i }));

    // Item 1 arrives at the L1 band — the level pill shows it.
    await screen.findByText(ITEM_L1.prompt);
    expect(screen.getByText('L1')).toBeInTheDocument();

    // Grade + advance: item 2 arrives at the L2 band.
    await user.click(screen.getAllByRole('radio')[0]!);
    await user.click(screen.getByRole('button', { name: /submit/i }));
    await screen.findByText('Correct');
    await user.click(screen.getByRole('button', { name: /next/i }));
    await screen.findByText(ITEM_L2.prompt);
    expect(screen.getByText('L2')).toBeInTheDocument();
  });

  it('F-128: the taking screen adopts the CityCard hero surface + SubwayProgress', async () => {
    hookState.snapshot = {
      data: EMPTY_SNAPSHOT,
      loading: false,
      error: null,
      isMock: true,
    };
    startDiagnostic.mockResolvedValue({
      runId: 41,
      item: ITEM_1,
      progress: { ordinal: 1, total: 2 },
    });

    const user = userEvent.setup();
    const { container } = renderWithRouter();
    await user.click(screen.getByRole('button', { name: /begin test/i }));
    await screen.findByText(ITEM_1.prompt);

    // Device #5 — the subway-line progress metaphor alongside the numeric
    // "N / M" readout (the readout stays, per the design doc precedent).
    expect(
      screen.getByRole('progressbar', { name: /diagnostic progress/i }),
    ).toBeInTheDocument();
    expect(container.querySelector('.km-subway')).not.toBeNull();
    // Devices #1/#2 — the live item card is a CityCard signboard/hanji-paper
    // surface with a leading DancheongRail, not a bare fragment.
    expect(container.querySelector('.km-diagnostic__card.km-citycard')).not.toBeNull();
    expect(
      container.querySelector('.km-diagnostic__card .km-dancheong-rail'),
    ).not.toBeNull();
    // The old manual progress-bar div is gone.
    expect(container.querySelector('.km-diagnostic__progress-fill')).toBeNull();
  });

  it('F-011: results show the honest placement disclaimer — no "Level 4" or fake timestamp', () => {
    hookState.snapshot = {
      data: POPULATED_SNAPSHOT,
      loading: false,
      error: null,
      isMock: false,
    };
    renderWithRouter();
    // The honest framing replaces the hard-coded "Against TOPIK II Level 4".
    expect(
      screen.getByText(
        /rough placement estimate, not an official TOPIK score/i,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Quick placement estimate')).toBeInTheDocument();
    // The dishonest literals must never come back (B-007 + F-011).
    expect(screen.queryByText(/Level 4/)).not.toBeInTheDocument();
    expect(screen.queryByText(/min ago/i)).not.toBeInTheDocument();
  });

  it('F-011: results render a confidence band only for dimensions with a real range', () => {
    hookState.snapshot = {
      data: POPULATED_SNAPSHOT,
      loading: false,
      error: null,
      isMock: false,
    };
    const { container } = renderWithRouter();
    // reading (54–70) draws a band; grammar (44–44, degenerate) must not.
    const bands = container.querySelectorAll('.km-skillbar__band');
    expect(bands).toHaveLength(1);
    expect((bands[0] as HTMLElement).style.left).toBe('54%');
    expect((bands[0] as HTMLElement).style.width).toBe('16%');
    // The band range is announced on the bar, not just painted.
    expect(
      screen.getByRole('progressbar', {
        name: 'Reading skill — estimated 62, range 54–70',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('progressbar', { name: 'Grammar skill' }),
    ).toBeInTheDocument();
  });

  it('walks intro → taking → reveal → advance → finish → done → results, server-graded', async () => {
    hookState.snapshot = {
      data: EMPTY_SNAPSHOT,
      loading: false,
      error: null,
      isMock: true,
    };
    startDiagnostic.mockResolvedValue({
      runId: 7,
      item: ITEM_1,
      progress: { ordinal: 1, total: 2 },
    });
    // Item 1 graded correct; the run continues, so the screen prefetches
    // item 2 via /next during the reveal dwell.
    answerDiagnostic.mockResolvedValueOnce({
      result: { correct: true, correctAnswer: 'a', explain: '발표하다 = announce.' },
      done: false,
      progress: { ordinal: 1, total: 2 },
    });
    nextDiagnostic.mockResolvedValueOnce({
      next: ITEM_2,
      progress: { ordinal: 2, total: 2 },
    });
    // Item 2 graded wrong; done → finish (no /next call).
    answerDiagnostic.mockResolvedValueOnce({
      result: { correct: false, correctAnswer: 'b', explain: '-(으)ㄹ 텐데 = conjecture.' },
      done: true,
      progress: { ordinal: 2, total: 2 },
    });
    finishDiagnostic.mockResolvedValue({ snapshot: POPULATED_SNAPSHOT });

    const user = userEvent.setup();
    const { container } = renderWithRouter();

    // ── intro ──
    await user.click(screen.getByRole('button', { name: /begin test/i }));

    // ── taking · item 1 (after startDiagnostic resolves) ──
    expect(
      await screen.findByText('회사에서 새로운 정책을 ( ) 했다.'),
    ).toBeInTheDocument();
    expect(startDiagnostic).toHaveBeenCalledTimes(1);

    // Progressbar ARIA contract is intact.
    const bar = screen.getByRole('progressbar', { name: /diagnostic progress/i });
    expect(bar).toHaveAttribute('aria-valuemax', '2');

    // Before the reveal lands, NO choice is marked correct — the client holds
    // no answer key. Pick choice a and submit.
    const item1Choices = screen.getAllByRole('radio');
    await user.click(item1Choices[0]); // 'a'
    await user.click(screen.getByRole('button', { name: /submit/i }));

    // ── reveal · item 1 (from the server's `result`, not client grading) ──
    expect(await screen.findByText('Correct')).toBeInTheDocument();
    expect(screen.getByText('발표하다 = announce.')).toBeInTheDocument();
    expect(answerDiagnostic).toHaveBeenCalledWith(7, {
      responseId: 101,
      picked: 'a',
      timeMs: expect.any(Number),
    });
    // The next item was prefetched during the reveal dwell (B-006).
    expect(nextDiagnostic).toHaveBeenCalledWith(7);

    // ── advance → item 2 ──
    await user.click(screen.getByRole('button', { name: /next/i }));
    expect(
      await screen.findByText('비가 ( ) 우산을 가지고 가세요.'),
    ).toBeInTheDocument();

    // Pick the wrong choice; the reveal still comes from the server.
    const item2Choices = screen.getAllByRole('radio');
    await user.click(item2Choices[0]); // 'a' — server says correct is 'b'
    await user.click(screen.getByRole('button', { name: /submit/i }));
    expect(await screen.findByText('Not quite')).toBeInTheDocument();

    // F-020: the reveal carries the "Ask about this" Chat handoff.
    expect(
      screen.getByRole('button', { name: 'Ask about this' }),
    ).toBeInTheDocument();

    // done:true → no second /next prefetch was issued.
    expect(nextDiagnostic).toHaveBeenCalledTimes(1);

    // ── finish (run done) → done ──
    await user.click(screen.getByRole('button', { name: /see results/i }));
    expect(finishDiagnostic).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Diagnostic complete')).toBeInTheDocument();
    // F-128 device #7 — the Done screen's completion glyph is the
    // hand-stamped milestone look, not the plain upright badge.
    expect(container.querySelector('.km-seal--milestone')).not.toBeNull();
    // P3b trim: the done view's Korean lives on the bilingual title itself —
    // exactly once (the redundant eyebrow twin is gone).
    expect(screen.getAllByText('진단평가 완료')).toHaveLength(1);
    // The stale hard-coded "TOPIK II L4" done-hint must never come back —
    // results pick their reference dynamically (a beginner run defaults to L2).
    expect(screen.queryByText(/Comparing against/)).not.toBeInTheDocument();

    // P3b consistency: "See gap map" got its own Korean (약점 지도 보기) —
    // no longer a 결과 보기 twin of the taking flow's "See results".
    expect(
      screen.getByRole('button', { name: '약점 지도 보기 · See gap map' }),
    ).toBeInTheDocument();

    // ── done → results (renders the server-returned snapshot) ──
    await user.click(screen.getByRole('button', { name: /see gap map/i }));
    expect(screen.getByText('Skills snapshot')).toBeInTheDocument();
    // The fresh snapshot carries a grammar dimension.
    expect(screen.getByText('문법')).toBeInTheDocument();
  });

  it('skips an item by submitting picked: null', async () => {
    hookState.snapshot = {
      data: EMPTY_SNAPSHOT,
      loading: false,
      error: null,
      isMock: true,
    };
    startDiagnostic.mockResolvedValue({
      runId: 9,
      item: ITEM_1,
      progress: { ordinal: 1, total: 2 },
    });
    answerDiagnostic.mockResolvedValueOnce({
      result: { correct: false, correctAnswer: 'a', explain: 'x' },
      done: false,
      progress: { ordinal: 1, total: 2 },
    });
    // The reveal triggers a background /next prefetch — give it a resolution.
    nextDiagnostic.mockResolvedValueOnce({
      next: ITEM_2,
      progress: { ordinal: 2, total: 2 },
    });

    const user = userEvent.setup();
    renderWithRouter();
    await user.click(screen.getByRole('button', { name: /begin test/i }));
    await screen.findByText('회사에서 새로운 정책을 ( ) 했다.');

    await user.click(screen.getByRole('button', { name: /skip/i }));

    await waitFor(() => {
      expect(answerDiagnostic).toHaveBeenCalledWith(9, {
        responseId: 101,
        picked: null,
        timeMs: expect.any(Number),
      });
    });
  });

  it('F-020: a wrong pick seeds Chat with the resolved correct/pick texts and the explanation', async () => {
    // The server keys the reveal by choice ID ('a') — the seed must resolve
    // both ids to their display text on the RIGHT labels: 'a' (발표) is
    // correct, 'b' (발견) the wrong pick, so a swap or a raw id fails here.
    const user = userEvent.setup();
    await driveToReveal(
      user,
      ITEM_1,
      { correct: false, correctAnswer: 'a', explain: '발표하다 = announce.' },
      1, // pick 'b' — wrong
    );
    await user.click(screen.getByRole('button', { name: 'Ask about this' }));

    const probe = screen.getByTestId('chat-seed');
    expect(probe.textContent).toContain('회사에서 새로운 정책을 ( ) 했다.');
    expect(probe.textContent).toContain('Correct answer: 발표');
    expect(probe.textContent).toContain('My answer: 발견 (incorrect)');
    expect(probe.textContent).toContain('Why: 발표하다 = announce.');
    expect(probe.textContent).toContain('mode=topik_prep');
  });

  it('F-020: an unresolvable correct-choice id OMITS the "Correct answer" line (no bare id)', async () => {
    // Corrupt data: the reveal names an id absent from the served choices.
    // Seeding "Correct answer: z" would be meaningless to the learner (the UI
    // labels choices ①②③④) and to the AI — the line must drop instead.
    const user = userEvent.setup();
    await driveToReveal(
      user,
      ITEM_1,
      { correct: false, correctAnswer: 'z', explain: '해설입니다.' },
      0,
    );
    await user.click(screen.getByRole('button', { name: 'Ask about this' }));

    const probe = screen.getByTestId('chat-seed');
    expect(probe.textContent).not.toContain('Correct answer');
    expect(probe.textContent).not.toContain(': z');
    // The rest of the seed is still worth asking about.
    expect(probe.textContent).toContain('회사에서 새로운 정책을 ( ) 했다.');
    expect(probe.textContent).toContain('Why: 해설입니다.');
  });

  it('F-020: a listening item seeds its audio transcript as the passage context', async () => {
    // Without the transcript the AI receives a stem like "무엇에 대한
    // 이야기입니까?" with no idea what was said.
    const listening: DiagnosticLiveItem = {
      ...ITEM_1,
      section: 'listening',
      prompt: '무엇에 대한 이야기입니까?',
      audio: { duration: 12, transcript: '내일은 전국에 비가 오겠습니다.' },
    };
    const user = userEvent.setup();
    await driveToReveal(
      user,
      listening,
      { correct: false, correctAnswer: 'a', explain: '날씨 예보입니다.' },
      1,
    );
    await user.click(screen.getByRole('button', { name: 'Ask about this' }));

    const probe = screen.getByTestId('chat-seed');
    expect(probe.textContent).toContain(
      '지문: 내일은 전국에 비가 오겠습니다.',
    );
  });

  it('F-020: an underline item seeds the passage with the underlined span marked', async () => {
    // A "밑줄 친 부분…" question is unanswerable without knowing WHICH span
    // was underlined — the seed marks it with ⟨ ⟩.
    const underlined: DiagnosticLiveItem = {
      ...ITEM_1,
      prompt: '밑줄 친 부분과 의미가 비슷한 것을 고르십시오.',
      passage: '그는 하루가 멀다 하고 도서관에 갔다.',
      underline: '하루가 멀다 하고',
    };
    const user = userEvent.setup();
    await driveToReveal(
      user,
      underlined,
      { correct: false, correctAnswer: 'a', explain: '거의 매일이라는 뜻입니다.' },
      1,
    );
    await user.click(screen.getByRole('button', { name: 'Ask about this' }));

    const probe = screen.getByTestId('chat-seed');
    expect(probe.textContent).toContain(
      '지문: 그는 ⟨하루가 멀다 하고⟩ 도서관에 갔다.',
    );
  });

  it('recovers from a mid-run answer failure via the inline Retry control', async () => {
    hookState.snapshot = {
      data: EMPTY_SNAPSHOT,
      loading: false,
      error: null,
      isMock: true,
    };
    startDiagnostic.mockResolvedValue({
      runId: 11,
      item: ITEM_1,
      progress: { ordinal: 1, total: 2 },
    });
    // First answer attempt fails (network), second (the retry) succeeds. This
    // exercises `retry`'s mid-run re-grade branch — dead before the inline
    // Retry button was wired in.
    answerDiagnostic
      .mockRejectedValueOnce(new Error('answer network down'))
      .mockResolvedValueOnce({
        result: { correct: true, correctAnswer: 'a', explain: '발표하다 = announce.' },
        done: false,
        progress: { ordinal: 1, total: 2 },
      });
    // The successful retry starts the /next prefetch — give it a resolution.
    nextDiagnostic.mockResolvedValueOnce({
      next: ITEM_2,
      progress: { ordinal: 2, total: 2 },
    });

    const user = userEvent.setup();
    renderWithRouter();
    await user.click(screen.getByRole('button', { name: /begin test/i }));
    await screen.findByText('회사에서 새로운 정책을 ( ) 했다.');

    // Pick + submit → the first answer call rejects → inline error + Retry.
    await user.click(screen.getAllByRole('radio')[0]); // 'a'
    await user.click(screen.getByRole('button', { name: /submit/i }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not submit your answer/i);

    // Retry replays the grade with the same picked choice; the reveal now lands.
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('Correct')).toBeInTheDocument();
    expect(answerDiagnostic).toHaveBeenCalledTimes(2);
    expect(answerDiagnostic).toHaveBeenLastCalledWith(11, {
      responseId: 101,
      picked: 'a',
      timeMs: expect.any(Number),
    });
  });

  it('renders the reveal immediately while the /next prefetch is still in flight (B-006)', async () => {
    hookState.snapshot = {
      data: EMPTY_SNAPSHOT,
      loading: false,
      error: null,
      isMock: true,
    };
    startDiagnostic.mockResolvedValue({
      runId: 13,
      item: ITEM_1,
      progress: { ordinal: 1, total: 2 },
    });
    answerDiagnostic.mockResolvedValueOnce({
      result: { correct: true, correctAnswer: 'a', explain: '발표하다 = announce.' },
      done: false,
      progress: { ordinal: 1, total: 2 },
    });
    // A /next that NEVER resolves until we say so — stands in for the
    // multi-second Claude generation. Pre-fix, this latency sat inside the
    // /answer request and withheld the reveal; now the reveal must render
    // while this promise is still pending.
    let resolveNext!: (value: DiagnosticNextResponse) => void;
    nextDiagnostic.mockImplementationOnce(
      () =>
        new Promise<DiagnosticNextResponse>((resolve) => {
          resolveNext = resolve;
        }),
    );

    const user = userEvent.setup();
    renderWithRouter();
    await user.click(screen.getByRole('button', { name: /begin test/i }));
    await screen.findByText('회사에서 새로운 정책을 ( ) 했다.');

    await user.click(screen.getAllByRole('radio')[0]); // 'a'
    await user.click(screen.getByRole('button', { name: /submit/i }));

    // The reveal is on screen although the next item hasn't been generated.
    expect(await screen.findByText('Correct')).toBeInTheDocument();
    expect(screen.getByText('발표하다 = announce.')).toBeInTheDocument();
    expect(nextDiagnostic).toHaveBeenCalledTimes(1);

    // Advancing before the prefetch lands shows a busy Next button, not a
    // freeze of the reveal.
    await user.click(screen.getByRole('button', { name: /loading|next/i }));
    expect(
      screen.getByRole('button', { name: /loading/i }),
    ).toHaveAttribute('aria-busy', 'true');

    // The generation completes → the awaited advance renders item 2.
    await act(async () => {
      resolveNext({ next: ITEM_2, progress: { ordinal: 2, total: 2 } });
    });
    expect(
      await screen.findByText('비가 ( ) 우산을 가지고 가세요.'),
    ).toBeInTheDocument();
  });

  it('finishes the run when the /next prefetch reports it over early (next:null)', async () => {
    hookState.snapshot = {
      data: EMPTY_SNAPSHOT,
      loading: false,
      error: null,
      isMock: true,
    };
    startDiagnostic.mockResolvedValue({
      runId: 15,
      item: ITEM_1,
      progress: { ordinal: 1, total: 8 },
    });
    // Not the last scheduled slot (done:false), but every remaining pool is
    // empty server-side — the prefetch answers `next: null`.
    answerDiagnostic.mockResolvedValueOnce({
      result: { correct: true, correctAnswer: 'a', explain: 'x' },
      done: false,
      progress: { ordinal: 1, total: 8 },
    });
    nextDiagnostic.mockResolvedValueOnce({
      next: null,
      progress: { ordinal: 1, total: 8 },
    });
    finishDiagnostic.mockResolvedValue({ snapshot: POPULATED_SNAPSHOT });

    const user = userEvent.setup();
    renderWithRouter();
    await user.click(screen.getByRole('button', { name: /begin test/i }));
    await screen.findByText('회사에서 새로운 정책을 ( ) 했다.');

    await user.click(screen.getAllByRole('radio')[0]); // 'a'
    await user.click(screen.getByRole('button', { name: /submit/i }));
    expect(await screen.findByText('Correct')).toBeInTheDocument();

    // The resolved null prefetch flips the footer to the last-item state.
    expect(await screen.findByText('Last item')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /see results/i }));
    expect(finishDiagnostic).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Diagnostic complete')).toBeInTheDocument();
  });

  it('auto-resyncs on a 409 answer conflict instead of dead-ending on Try again (E-DG-409)', async () => {
    hookState.snapshot = {
      data: POPULATED_SNAPSHOT,
      loading: false,
      error: null,
      isMock: false,
      refetch: refetchSpy,
    };
    startDiagnostic.mockResolvedValue({
      runId: 21,
      item: ITEM_1,
      progress: { ordinal: 1, total: 2 },
    });
    // The server reports the answer was already recorded (double-submit / lost
    // success). The client must NOT surface a re-gradeable "Try again".
    answerDiagnostic.mockRejectedValue(
      new ApiError('responseId does not match the current item', {
        status: 409,
        code: 'conflict',
      }),
    );

    const user = userEvent.setup();
    renderWithRouter();
    // A prior snapshot exists, so the retake CTA on results enters the run.
    await user.click(screen.getByRole('button', { name: /re-test diagnostic/i }));
    await user.click(screen.getByRole('button', { name: /begin test/i }));
    await screen.findByText('회사에서 새로운 정책을 ( ) 했다.');

    await user.click(screen.getAllByRole('radio')[0]); // 'a'
    await user.click(screen.getByRole('button', { name: /submit/i }));

    // Resync: the latest-snapshot refetch fires, the Taking flow leaves for the
    // results view (a prior snapshot existed), and the toast announces it. There
    // is NO "Try again" dead-end and NO lingering submit error.
    await waitFor(() => {
      expect(refetchSpy).toHaveBeenCalledTimes(1);
    });
    expect(
      await screen.findByText(/answer already recorded — continuing/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /try again/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/could not submit your answer/i),
    ).not.toBeInTheDocument();
    expect(screen.getByText('Skills snapshot')).toBeInTheDocument();
  });

  it('renders the fatal snapshot failure as fixed copy with a live Retry (F-UP-018)', async () => {
    // The PROD gate made this branch reachable in prod. It must follow the
    // ErrorCard contract: author-controlled copy (never the server prose on
    // ApiError.message) + a Retry wired to the snapshot refetch — and the
    // IntroBlock still offers "Begin" so the page is never a dead end.
    refetchSpy.mockClear();
    hookState.snapshot = {
      data: null,
      loading: false,
      error: new ApiError(
        'relation "diagnostic_snapshots" does not exist',
        { status: 500, code: 'server_error' },
      ),
      isMock: false,
      refetch: refetchSpy,
    };

    const user = userEvent.setup();
    renderWithRouter();

    // Fixed copy, not the server prose.
    expect(
      await screen.findByText(/couldn.t load your diagnostic results/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/diagnostic_snapshots/),
    ).not.toBeInTheDocument();

    // Retry actually re-runs the snapshot fetch.
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetchSpy).toHaveBeenCalledTimes(1);

    // Not stranded: the intro's Begin control still renders below the card.
    expect(
      screen.getByRole('button', { name: /begin test/i }),
    ).toBeInTheDocument();
  });

  it('surfaces an ErrorCard when starting the run fails', async () => {
    hookState.snapshot = {
      data: EMPTY_SNAPSHOT,
      loading: false,
      error: null,
      isMock: true,
    };
    startDiagnostic.mockRejectedValue(new Error('network down'));

    const user = userEvent.setup();
    renderWithRouter();
    await user.click(screen.getByRole('button', { name: /begin test/i }));

    expect(
      await screen.findByText(/could not start the diagnostic/i),
    ).toBeInTheDocument();
  });
});

describe('B1 fix — prompt renders the server instruction, never duplicated as the passage', () => {
  beforeEach(() => {
    hookState.snapshot = {
      data: null,
      loading: true,
      error: null,
      isMock: false,
      refetch: refetchSpy,
    };
    refetchSpy.mockReset();
    startDiagnostic.mockReset();
    answerDiagnostic.mockReset();
    nextDiagnostic.mockReset();
    finishDiagnostic.mockReset();
  });

  it('renders the server prompt once, and it is a DIFFERENT string from the passage', async () => {
    // Before the fix, the server sent `stem` as BOTH the prompt and the
    // passage — the same Korean string printed twice. The server now sends
    // `instruction` as `prompt`, a genuinely different string from `passage`.
    hookState.snapshot = { data: EMPTY_SNAPSHOT, loading: false, error: null, isMock: true };
    const item: DiagnosticLiveItem = {
      responseId: 301,
      ordinal: 1,
      section: 'reading',
      level: 'L4',
      kind: 'passage-mc',
      prompt: '이 글의 내용과 같은 것을 고르십시오.',
      passage: '어제는 친구를 만나서 영화를 봤습니다. 영화가 정말 재미있었습니다.',
      choices: [
        { id: 'a', kr: '보기 1', en: '' },
        { id: 'b', kr: '보기 2', en: '' },
      ],
    };
    startDiagnostic.mockResolvedValue({ runId: 41, item, progress: { ordinal: 1, total: 1 } });

    const user = userEvent.setup();
    renderWithRouter();
    await user.click(screen.getByRole('button', { name: /begin test/i }));
    await screen.findByText(item.prompt);

    expect(item.prompt).not.toBe(item.passage);
    expect(screen.getAllByText(item.prompt)).toHaveLength(1);
    expect(screen.getByText(item.passage!)).toBeInTheDocument();
  });
});

describe('F-119/F-206 fix — Diagnostic listening audio is real, or honestly absent', () => {
  beforeEach(() => {
    hookState.snapshot = {
      data: null,
      loading: true,
      error: null,
      isMock: false,
      refetch: refetchSpy,
    };
    refetchSpy.mockReset();
    startDiagnostic.mockReset();
    answerDiagnostic.mockReset();
    nextDiagnostic.mockReset();
    finishDiagnostic.mockReset();
  });

  it('renders a REAL <audio> player (TopikStudyAudio), never the fake AudioBlock Play button, when audioUrl/spans are present', async () => {
    hookState.snapshot = { data: EMPTY_SNAPSHOT, loading: false, error: null, isMock: true };
    const item: DiagnosticLiveItem = {
      responseId: 302,
      ordinal: 1,
      section: 'listening',
      level: 'L4',
      kind: 'audio-mc',
      prompt: '다음을 듣고 물음에 답하십시오.',
      audio: { duration: 30, transcript: '내일은 전국에 비가 오겠습니다.' },
      audioUrl: '/topik/audio/555101/2',
      audioStartMs: 12_000,
      audioEndMs: 34_000,
      choices: [
        { id: 'a', kr: '보기 1', en: '' },
        { id: 'b', kr: '보기 2', en: '' },
      ],
    };
    startDiagnostic.mockResolvedValue({ runId: 42, item, progress: { ordinal: 1, total: 1 } });

    const user = userEvent.setup();
    renderWithRouter();
    await user.click(screen.getByRole('button', { name: /begin test/i }));
    await screen.findByText(item.prompt);

    // The real player: a single <audio src> element seeking the item's span.
    const audioEl = document.querySelector('audio');
    expect(audioEl).not.toBeNull();
    expect(audioEl).toHaveAttribute('src', item.audioUrl);
    expect(
      screen.getByRole('button', { name: /Play question audio/i }),
    ).toBeInTheDocument();
    // The fake player's Play button never renders — there is a real one.
    expect(screen.queryByRole('button', { name: 'Play' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('progressbar', { name: 'Playback progress' }),
    ).not.toBeInTheDocument();
    // B1 fix-pass: the honest "no audio yet" note must NEVER render beside a
    // working real player — before this fix it did, on this exact item shape
    // (audio.transcript ships alongside audioUrl/spans on the wire).
    expect(
      screen.queryByText(/no audio for this question/i),
    ).not.toBeInTheDocument();
  });

  it('falls back to the honest transcript card (no fake Play button) when the item carries no audioUrl', async () => {
    hookState.snapshot = { data: EMPTY_SNAPSHOT, loading: false, error: null, isMock: true };
    const item: DiagnosticLiveItem = {
      responseId: 303,
      ordinal: 1,
      section: 'listening',
      level: 'L4',
      kind: 'audio-mc',
      prompt: '다음을 듣고 물음에 답하십시오.',
      audio: { duration: 30, transcript: '오늘은 날씨가 맑습니다.' },
      // No audioUrl/audioStartMs/audioEndMs — the span-less case.
      choices: [
        { id: 'a', kr: '보기 1', en: '' },
        { id: 'b', kr: '보기 2', en: '' },
      ],
    };
    startDiagnostic.mockResolvedValue({ runId: 43, item, progress: { ordinal: 1, total: 1 } });

    const user = userEvent.setup();
    renderWithRouter();
    await user.click(screen.getByRole('button', { name: /begin test/i }));
    await screen.findByText(item.prompt);

    // No real player, no fake Play button, no fake progressbar.
    expect(document.querySelector('audio')).toBeNull();
    expect(
      screen.queryByRole('button', { name: /play question audio/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Play' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('progressbar', { name: 'Playback progress' }),
    ).not.toBeInTheDocument();

    // No real audio exists for this item — the honest note IS shown, up
    // front, before the transcript is revealed.
    expect(
      screen.getByText(/no audio for this question/i),
    ).toBeInTheDocument();

    // The transcript is reachable, honestly labeled — revealing it surfaces
    // the actual content instead of implying playback, and clears the note.
    const transcriptButton = screen.getByRole('button', { name: 'Transcript' });
    await user.click(transcriptButton);
    expect(screen.getByText(item.audio!.transcript)).toBeInTheDocument();
    expect(
      screen.queryByText(/no audio for this question/i),
    ).not.toBeInTheDocument();
  });
});

describe('writing item (diagnostic-upgrade Phase B) — textarea, not ChoiceList', () => {
  beforeEach(() => {
    hookState.snapshot = {
      data: null,
      loading: true,
      error: null,
      isMock: false,
      refetch: refetchSpy,
    };
    refetchSpy.mockReset();
    startDiagnostic.mockReset();
    answerDiagnostic.mockReset();
    nextDiagnostic.mockReset();
    finishDiagnostic.mockReset();
  });

  const WRITING_ITEM: DiagnosticLiveItem = {
    responseId: 401,
    ordinal: 21,
    section: 'writing',
    level: 'L3',
    kind: 'writing-production',
    prompt: 'Rewrite using -는 것 같다.',
    passage: '그는 학생이다.',
    hint: 'He is a student.',
    choices: [],
  };

  it('renders a textarea for a writing item, not ChoiceList radios', async () => {
    hookState.snapshot = { data: EMPTY_SNAPSHOT, loading: false, error: null, isMock: true };
    startDiagnostic.mockResolvedValue({
      runId: 51,
      item: WRITING_ITEM,
      progress: { ordinal: 21, total: 22 },
    });

    const user = userEvent.setup();
    renderWithRouter();
    await user.click(screen.getByRole('button', { name: /begin test/i }));
    await screen.findByText(WRITING_ITEM.prompt);

    // The KR base sentence + EN gloss render (reused passage/hint fields).
    expect(screen.getByText('그는 학생이다.')).toBeInTheDocument();
    expect(screen.getByText('He is a student.')).toBeInTheDocument();

    // A free-text answer box, not the MC radiogroup.
    expect(
      screen.getByRole('textbox', { name: /write one sentence in korean/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(screen.queryAllByRole('radio')).toHaveLength(0);

    // Submit starts disabled — nothing typed yet.
    expect(screen.getByRole('button', { name: /submit/i })).toBeDisabled();
  });

  it('typing + submit sends the typed text as `picked`', async () => {
    hookState.snapshot = { data: EMPTY_SNAPSHOT, loading: false, error: null, isMock: true };
    startDiagnostic.mockResolvedValue({
      runId: 52,
      item: WRITING_ITEM,
      progress: { ordinal: 21, total: 22 },
    });
    answerDiagnostic.mockResolvedValueOnce({
      result: {
        correct: true,
        correctAnswer: 'writing',
        explain: 'Great use of the pattern.',
        verdict: 'good',
        summary: 'Great use of the pattern.',
        corrections: [],
        referenceModelKr: '그는 학생인 것 같다.',
        referenceModelEn: 'It seems he is a student.',
      },
      done: false,
      progress: { ordinal: 21, total: 22 },
    });

    const user = userEvent.setup();
    renderWithRouter();
    await user.click(screen.getByRole('button', { name: /begin test/i }));
    await screen.findByText(WRITING_ITEM.prompt);

    const textbox = screen.getByRole('textbox', {
      name: /write one sentence in korean/i,
    });
    await user.type(textbox, '그는 학생인 것 같다.');
    expect(screen.getByRole('button', { name: /submit/i })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: /submit/i }));

    expect(answerDiagnostic).toHaveBeenCalledWith(
      52,
      expect.objectContaining({
        responseId: WRITING_ITEM.responseId,
        picked: '그는 학생인 것 같다.',
      }),
    );
  });

  it('Skip sends `picked: null` on a writing item, same as any other item', async () => {
    hookState.snapshot = { data: EMPTY_SNAPSHOT, loading: false, error: null, isMock: true };
    startDiagnostic.mockResolvedValue({
      runId: 53,
      item: WRITING_ITEM,
      progress: { ordinal: 21, total: 22 },
    });
    answerDiagnostic.mockResolvedValueOnce({
      result: {
        correct: false,
        correctAnswer: 'writing',
        explain: 'No answer was submitted.',
        verdict: 'incorrect',
        summary: 'No answer was submitted.',
        corrections: [],
        referenceModelKr: '그는 학생인 것 같다.',
        referenceModelEn: 'It seems he is a student.',
      },
      done: false,
      progress: { ordinal: 21, total: 22 },
    });

    const user = userEvent.setup();
    renderWithRouter();
    await user.click(screen.getByRole('button', { name: /begin test/i }));
    await screen.findByText(WRITING_ITEM.prompt);
    await user.click(screen.getByRole('button', { name: /skip/i }));

    expect(answerDiagnostic).toHaveBeenCalledWith(
      53,
      expect.objectContaining({ responseId: WRITING_ITEM.responseId, picked: null }),
    );
  });

  it('the reveal shows the Claude verdict/summary/corrections/reference model, not the MC correct/explain reveal', async () => {
    hookState.snapshot = { data: EMPTY_SNAPSHOT, loading: false, error: null, isMock: true };
    startDiagnostic.mockResolvedValue({
      runId: 54,
      item: WRITING_ITEM,
      progress: { ordinal: 21, total: 22 },
    });
    answerDiagnostic.mockResolvedValueOnce({
      result: {
        correct: false,
        correctAnswer: 'writing',
        explain: 'The pattern was not used.',
        verdict: 'needs_work',
        summary: 'The pattern was not used.',
        corrections: [
          { span: '학생이다', issue: 'missing the target pattern', fix: '학생인 것 같다' },
        ],
        referenceModelKr: '그는 학생인 것 같다.',
        referenceModelEn: 'It seems he is a student.',
      },
      done: false,
      progress: { ordinal: 21, total: 22 },
    });

    const user = userEvent.setup();
    renderWithRouter();
    await user.click(screen.getByRole('button', { name: /begin test/i }));
    await screen.findByText(WRITING_ITEM.prompt);
    await user.type(
      screen.getByRole('textbox', { name: /write one sentence in korean/i }),
      '그는 학생이다.',
    );
    await user.click(screen.getByRole('button', { name: /submit/i }));

    // The Claude reveal fields render...
    expect(await screen.findByText('The pattern was not used.')).toBeInTheDocument();
    expect(screen.getByText('Needs work')).toBeInTheDocument();
    expect(screen.getByText('missing the target pattern')).toBeInTheDocument();
    expect(screen.getByText('학생인 것 같다')).toBeInTheDocument();
    expect(screen.getByText('그는 학생인 것 같다.')).toBeInTheDocument();
    expect(screen.getByText('It seems he is a student.')).toBeInTheDocument();
    // ...the MC "Correct"/"Not quite" reveal Eyebrow does NOT render for a
    // writing item (WritingReveal replaces it entirely).
    expect(screen.queryByText('Not quite')).not.toBeInTheDocument();
    // No AskAboutThisButton — a writing item has no choices for it to resolve.
    expect(
      screen.queryByRole('button', { name: 'Ask about this' }),
    ).not.toBeInTheDocument();
  });
});
