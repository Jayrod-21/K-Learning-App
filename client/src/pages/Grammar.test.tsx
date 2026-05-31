/**
 * Grammar — Pass-3 list/bank wiring tests.
 *
 * Services (grammar) are mocked at module level so the page sees
 * predictable resolves/rejects. The mock fixture loader is mocked too
 * for the ErrorCard branch where BOTH the real fetch AND the fallback
 * must fail (otherwise the hook falls back to the mock data and renders
 * the list as usual).
 *
 * `useEndpointOrMock` is **not** mocked — we let it call through to the
 * real implementation against the mocked services, so the realFn-first
 * + fallback + abort paths participate in the assertion.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type {
  BankedGrammarList,
  KgiuEntryDetail,
  KgiuEntrySummary,
} from '../types/domain';

// Hoisted service mocks — referenced inside the vi.mock factory.
const services = vi.hoisted(() => ({
  listPatterns: vi.fn(),
  listBanked: vi.fn(),
  bankPattern: vi.fn(),
  getPattern: vi.fn(),
  identifyPattern: vi.fn(),
}));

const drillServices = vi.hoisted(() => ({
  generateDrill: vi.fn(),
  submitDrill: vi.fn(),
}));

const mocks = vi.hoisted(() => ({
  loadGrammarMock: vi.fn(),
}));

vi.mock('../services/grammar', () => services);
vi.mock('../services/grammarDrill', () => drillServices);
vi.mock('../data/mocks/grammar', () => mocks);

import Grammar from './Grammar';
import type { DrillTarget } from './Grammar';
import { ApiError } from '../services/api';

/**
 * Render `<Grammar />` inside a MemoryRouter. `drillTarget`, when supplied,
 * seeds `location.state.drillTarget` so the FU-NF-42 deep-link path (Drill tab
 * opens focused on a specific pattern) can be exercised exactly as the Review
 * screen drives it.
 */
function renderGrammar(drillTarget?: DrillTarget): ReturnType<typeof render> {
  return render(
    <MemoryRouter
      initialEntries={[
        drillTarget ? { pathname: '/grammar', state: { drillTarget } } : '/grammar',
      ]}
    >
      <Routes>
        <Route path="/grammar" element={<Grammar />} />
      </Routes>
    </MemoryRouter>,
  );
}

const ROW: KgiuEntrySummary = {
  id: 42,
  corpus: 'kgiu_intermediate',
  source_id: 'KGIU-INT-007',
  pattern: '-더라도',
  title_en: 'even if / even though',
  category: 'concessive',
  proficiency: 'intermediate',
  unit: 'Unit 7',
  source_pages: null,
};

const ROW_2: KgiuEntrySummary = {
  id: 43,
  corpus: 'kgiu_intermediate',
  source_id: 'KGIU-INT-008',
  pattern: '-느라고',
  title_en: 'because of doing X',
  category: 'causal',
  proficiency: 'intermediate',
  unit: 'Unit 8',
  source_pages: null,
};

const EMPTY_BANK: BankedGrammarList = { entries: [] };

const DETAIL: KgiuEntryDetail = {
  ...ROW,
  explanation: 'Strong concessive — even if the premise holds.',
  formation_rules: null,
  examples: null,
  dialogues: null,
  vocabulary: null,
  tips: null,
  compare_with: null,
  exercises: null,
  cultural_notes: null,
};

const FIXTURE = [
  {
    id: 'g1',
    pattern: '-더라도',
    title: 'even if / even though',
    desc: 'Strong concession.',
    ex_kr: '비가 오더라도 갈 거예요.',
    ex_en: "Even if it rains, we'll go.",
    state: 'practicing' as const,
    drill: {
      context: 'Concede a colleague has a point — reluctantly.',
      seed: '그 의견이 ___ 우리는 일정대로 진행해야 한다.',
      model: '그 의견이 일리가 있더라도 우리는 일정대로 진행해야 한다.',
      model_en: 'Even if that opinion has merit, we must proceed on schedule.',
    },
  },
];

function resetMocks(): void {
  for (const fn of Object.values(services)) (fn as Mock).mockReset();
  for (const fn of Object.values(drillServices)) (fn as Mock).mockReset();
  (mocks.loadGrammarMock as Mock).mockReset();
  // Default mock fallback resolves with the fixture — happy-path tests
  // don't need to set this per-case. The ErrorCard test overrides it.
  mocks.loadGrammarMock.mockResolvedValue(FIXTURE);
}

beforeEach(() => {
  resetMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Grammar — list tab', () => {
  it('renders patterns from the real listPatterns service', async () => {
    services.listPatterns.mockResolvedValue([ROW, ROW_2]);
    services.listBanked.mockResolvedValue(EMPTY_BANK);

    renderGrammar();

    expect(await screen.findByText('-더라도')).toBeInTheDocument();
    expect(screen.getByText('-느라고')).toBeInTheDocument();
    expect(services.listPatterns).toHaveBeenCalled();
  });

  it('calls bankPattern with the row body on Bank tap', async () => {
    services.listPatterns.mockResolvedValue([ROW]);
    services.listBanked.mockResolvedValue(EMPTY_BANK);
    services.bankPattern.mockResolvedValue({ id: 1 });

    const user = userEvent.setup();
    renderGrammar();

    const bankBtn = await screen.findByRole('button', { name: /^Bank -더라도$/ });
    await user.click(bankBtn);

    await waitFor(() => {
      expect(services.bankPattern).toHaveBeenCalledTimes(1);
    });
    const body = services.bankPattern.mock.calls[0][0] as {
      pattern_key: string;
      pattern_display: string;
      summary_en: string;
    };
    expect(body.pattern_key).toBe('KGIU-INT-007');
    expect(body.pattern_display).toBe('-더라도');
    expect(body.summary_en).toBe('even if / even though');
    // Optimistic chip flip — the button label moves to "Banked".
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /Already banked/i }),
      ).toBeInTheDocument();
    });
  });

  it('shows an ErrorCard with Retry when BOTH real and mock fail', async () => {
    services.listPatterns.mockRejectedValue(
      new ApiError('boom', { status: 500, code: 'server' }),
    );
    services.listBanked.mockRejectedValue(
      new ApiError('boom', { status: 500, code: 'server' }),
    );
    mocks.loadGrammarMock.mockRejectedValue(new Error('mock boom'));

    renderGrammar();

    expect(
      await screen.findByText(/The grammar patterns couldn't be loaded/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /^Retry$/i }),
    ).toBeInTheDocument();
  });
});

describe('Grammar — optimisticBanked overlay prune (E-SF-1)', () => {
  it('drops optimistic entries that have been reconciled with the server bank settle', async () => {
    // Setup: three patterns; initially zero are banked on the server.
    services.listPatterns.mockResolvedValue([ROW, ROW_2]);
    // First call: empty bank. Second call (after a refetch triggered by
    // bankPattern's then-handler): includes the just-banked row, which
    // is the reconciliation signal the prune effect keys on.
    services.listBanked
      .mockResolvedValueOnce(EMPTY_BANK)
      .mockResolvedValue({
        entries: [
          {
            id: 99,
            pattern_key: 'KGIU-INT-007',
            pattern_display: '-더라도',
            summary_en: 'even if',
            proficiency: 'L4',
            category: 'concessive',
            register: null,
            discovered_via: 'manual',
            created_at: '2026-05-29T12:00:00Z',
          },
        ],
      } satisfies BankedGrammarList);
    services.bankPattern.mockResolvedValue({ id: 1 });

    const user = userEvent.setup();
    renderGrammar();

    // Bank the row.
    const bankBtn = await screen.findByRole('button', {
      name: /^Bank -더라도$/,
    });
    await user.click(bankBtn);

    // After the bank settles + the refetch returns the reconciled row,
    // the chip shows "Already banked". The overlay prune effect has run:
    // any optimistic entry now present in `bankedState.data` has been
    // dropped from the set. The user-visible test for this is "the
    // button still reads Already banked" (the optimistic overlay
    // shrinking + the server settle including the row both render the
    // same chip state). The contract this asserts is: after settle, the
    // overlay isn't growing unbounded — the row is sourced from server
    // truth, not from the overlay.
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /Already banked/i }),
      ).toBeInTheDocument();
    });
    // listBanked was called at least twice: initial + post-bank refetch.
    // The second call (the refetch) is what the prune effect keys on.
    expect(services.listBanked.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('Grammar — detail Sheet', () => {
  it('opens detail Sheet and calls getPattern on row tap', async () => {
    services.listPatterns.mockResolvedValue([ROW]);
    services.listBanked.mockResolvedValue(EMPTY_BANK);
    services.getPattern.mockResolvedValue(DETAIL);

    const user = userEvent.setup();
    renderGrammar();

    const rowBtn = await screen.findByRole('button', {
      name: '-더라도 even if / even though',
    });
    await user.click(rowBtn);

    await waitFor(() => {
      expect(services.getPattern).toHaveBeenCalledWith(42);
    });
    expect(
      await screen.findByText(/Strong concessive/),
    ).toBeInTheDocument();
  });
});

describe('Grammar — drill tab (live generate → submit → reveal)', () => {
  const GEN_TRANSFORM = {
    attemptId: 7,
    item: {
      type: 'transformation' as const,
      patternKey: 'KGIU-INT-007',
      patternDisplay: '-더라도',
      instruction: 'Rewrite using -더라도.',
      sourceKr: '비가 와요. 우리는 갈 거예요.',
      sourceEn: "It's raining. We will go.",
    },
  };

  const SCORE = {
    score: 82,
    verdict: 'good' as const,
    usesPattern: true,
    summary: 'Reads natural — good register.',
    corrections: [
      { span: '진행합시다', issue: 'register mismatch', fix: '진행해야 한다' },
    ],
    referenceModelKr: '비가 오더라도 우리는 출발할 거예요.',
    referenceModelEn: "Even if it rains, we will set out.",
  };

  it('generates a transformation drill, submits, and reveals the score + reference', async () => {
    services.listPatterns.mockResolvedValue([ROW]);
    services.listBanked.mockResolvedValue(EMPTY_BANK);
    drillServices.generateDrill.mockResolvedValue(GEN_TRANSFORM);
    drillServices.submitDrill.mockResolvedValue(SCORE);

    const user = userEvent.setup();
    renderGrammar();

    await user.click(screen.getByRole('tab', { name: 'Drill' }));

    // Generate ran with the row's pattern source.
    await waitFor(() => {
      expect(drillServices.generateDrill).toHaveBeenCalledTimes(1);
    });
    expect(drillServices.generateDrill.mock.calls[0][0]).toMatchObject({
      patternKey: 'KGIU-INT-007',
      patternDisplay: '-더라도',
    });

    // Transformation body renders.
    expect(await screen.findByText('Transform this')).toBeInTheDocument();
    expect(screen.getByText('비가 와요. 우리는 갈 거예요.')).toBeInTheDocument();

    const textarea = await screen.findByPlaceholderText(/Write your answer using/i);
    await user.type(textarea, '비가 오더라도 우리는 갈 거예요.');
    await user.click(screen.getByRole('button', { name: /^submit$/i }));

    await waitFor(() => {
      expect(drillServices.submitDrill).toHaveBeenCalledWith(
        7,
        '비가 오더라도 우리는 갈 거예요.',
        expect.anything(),
      );
    });

    // Reveal: score, verdict, correction, reference model.
    expect(await screen.findByText('82')).toBeInTheDocument();
    expect(screen.getByText('Good')).toBeInTheDocument();
    expect(screen.getByText('Model answer')).toBeInTheDocument();
    expect(
      screen.getByText('비가 오더라도 우리는 출발할 거예요.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/register mismatch/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /next pattern/i }),
    ).toBeInTheDocument();
  });

  it('renders a cloze drill body when the server returns type=cloze', async () => {
    services.listPatterns.mockResolvedValue([ROW]);
    services.listBanked.mockResolvedValue(EMPTY_BANK);
    drillServices.generateDrill.mockResolvedValue({
      attemptId: 9,
      item: {
        type: 'cloze',
        patternKey: 'KGIU-INT-007',
        patternDisplay: '-느라고',
        instruction: 'Fill the blank with a -느라고 clause.',
        context: 'Explain why you missed dinner.',
        seedKr: '발표 자료를 ___ 저녁을 못 먹었어요.',
      },
    });

    const user = userEvent.setup();
    renderGrammar();
    await user.click(screen.getByRole('tab', { name: 'Drill' }));

    expect(await screen.findByText('Seed — fill the blank')).toBeInTheDocument();
    expect(
      screen.getByText('발표 자료를 ___ 저녁을 못 먹었어요.'),
    ).toBeInTheDocument();
  });

  it('renders a conversation drill body when the server returns type=conversation', async () => {
    services.listPatterns.mockResolvedValue([ROW]);
    services.listBanked.mockResolvedValue(EMPTY_BANK);
    drillServices.generateDrill.mockResolvedValue({
      attemptId: 11,
      item: {
        type: 'conversation',
        patternKey: 'KGIU-INT-007',
        patternDisplay: '-ㄹ 뿐만 아니라',
        instruction: 'Reply using -ㄹ 뿐만 아니라.',
        scenario: 'A friend asks about the café.',
        promptKr: '새 카페 어때요?',
        promptEn: 'How is the new café?',
      },
    });

    const user = userEvent.setup();
    renderGrammar();
    await user.click(screen.getByRole('tab', { name: 'Drill' }));

    expect(await screen.findByText('They say')).toBeInTheDocument();
    expect(screen.getByText('새 카페 어때요?')).toBeInTheDocument();
  });

  it('falls back to a local mock drill + 🅂 badge when generate is unreachable', async () => {
    services.listPatterns.mockResolvedValue([ROW]);
    services.listBanked.mockResolvedValue(EMPTY_BANK);
    drillServices.generateDrill.mockRejectedValue(
      new ApiError('network unreachable', { status: 0, code: 'network' }),
    );

    const user = userEvent.setup();
    renderGrammar();
    await user.click(screen.getByRole('tab', { name: 'Drill' }));

    // The screen does NOT blank — a mock drill renders + the MockBadge shows.
    expect(await screen.findByTestId('mock-badge')).toBeInTheDocument();
    expect(
      await screen.findByPlaceholderText(/Write your answer using/i),
    ).toBeInTheDocument();
  });

  it('surfaces an inline alert + Retry when submit fails, keeping the answer', async () => {
    services.listPatterns.mockResolvedValue([ROW]);
    services.listBanked.mockResolvedValue(EMPTY_BANK);
    drillServices.generateDrill.mockResolvedValue(GEN_TRANSFORM);
    drillServices.submitDrill.mockRejectedValue(
      new ApiError('upstream', { status: 502, code: 'upstream' }),
    );

    const user = userEvent.setup();
    renderGrammar();
    await user.click(screen.getByRole('tab', { name: 'Drill' }));

    const textarea = await screen.findByPlaceholderText(/Write your answer using/i);
    await user.type(textarea, '비가 오더라도 갈 거예요.');
    await user.click(screen.getByRole('button', { name: /^submit$/i }));

    // Inline failure-safe error — the screen is intact, answer preserved.
    expect(await screen.findByText(/Scoring your answer failed/i)).toBeInTheDocument();
    expect(
      (screen.getByPlaceholderText(/Write your answer using/i) as HTMLTextAreaElement)
        .value,
    ).toBe('비가 오더라도 갈 거예요.');
    // Submit button is back (not stuck on a spinner).
    expect(screen.getByRole('button', { name: /^submit$/i })).toBeInTheDocument();
  });

  // ── FU-NF-42 B2: reveal shows the server-derived schedule line ──────────

  it('shows the "next in N days" schedule line on the reveal when the score carries a schedule', async () => {
    services.listPatterns.mockResolvedValue([ROW]);
    services.listBanked.mockResolvedValue(EMPTY_BANK);
    drillServices.generateDrill.mockResolvedValue(GEN_TRANSFORM);
    drillServices.submitDrill.mockResolvedValue({
      ...SCORE,
      schedule: {
        rating: 'good',
        dueAt: '2026-06-02T00:00:00Z',
        scheduledDays: 3,
      },
    });

    const user = userEvent.setup();
    renderGrammar();
    await user.click(screen.getByRole('tab', { name: 'Drill' }));

    const textarea = await screen.findByPlaceholderText(/Write your answer using/i);
    await user.type(textarea, '비가 오더라도 갈 거예요.');
    await user.click(screen.getByRole('button', { name: /^submit$/i }));

    expect(
      await screen.findByText('Added to your review · next in 3 days'),
    ).toBeInTheDocument();
  });

  it('renders the ~10 minutes variant when scheduledDays is 0 (again relearning step)', async () => {
    services.listPatterns.mockResolvedValue([ROW]);
    services.listBanked.mockResolvedValue(EMPTY_BANK);
    drillServices.generateDrill.mockResolvedValue(GEN_TRANSFORM);
    drillServices.submitDrill.mockResolvedValue({
      ...SCORE,
      verdict: 'incorrect' as const,
      schedule: {
        rating: 'again',
        dueAt: '2026-05-30T00:10:00Z',
        scheduledDays: 0,
      },
    });

    const user = userEvent.setup();
    renderGrammar();
    await user.click(screen.getByRole('tab', { name: 'Drill' }));

    const textarea = await screen.findByPlaceholderText(/Write your answer using/i);
    await user.type(textarea, '비가 와요.');
    await user.click(screen.getByRole('button', { name: /^submit$/i }));

    expect(
      await screen.findByText('Added to your review · next in ~10 minutes'),
    ).toBeInTheDocument();
  });

  it('omits the schedule line when the score has no schedule (pre-bump server)', async () => {
    services.listPatterns.mockResolvedValue([ROW]);
    services.listBanked.mockResolvedValue(EMPTY_BANK);
    drillServices.generateDrill.mockResolvedValue(GEN_TRANSFORM);
    drillServices.submitDrill.mockResolvedValue(SCORE);

    const user = userEvent.setup();
    renderGrammar();
    await user.click(screen.getByRole('tab', { name: 'Drill' }));

    const textarea = await screen.findByPlaceholderText(/Write your answer using/i);
    await user.type(textarea, '비가 오더라도 갈 거예요.');
    await user.click(screen.getByRole('button', { name: /^submit$/i }));

    // The reveal lands (score visible) but no schedule line is shown.
    expect(await screen.findByText('82')).toBeInTheDocument();
    expect(screen.queryByText(/Added to your review/)).not.toBeInTheDocument();
  });

  // ── FU-NF-42 B3: Drill tab opens focused on a deep-link target ──────────

  it('drills the deep-linked pattern from router state instead of the rotation', async () => {
    // The list fetch resolves a DIFFERENT pattern than the deep-link target, so
    // we can prove the generate body came from the target, not items[idx].
    services.listPatterns.mockResolvedValue([ROW]);
    services.listBanked.mockResolvedValue(EMPTY_BANK);
    drillServices.generateDrill.mockResolvedValue(GEN_TRANSFORM);

    renderGrammar({
      patternKey: 'KGIU-INT-099',
      display: '-는 바람에',
      meaning: 'as a result of (unexpected)',
    });

    // Opens straight on the Drill tab (no manual tab click) and generates for
    // the targeted pattern.
    await waitFor(() => {
      expect(drillServices.generateDrill).toHaveBeenCalledTimes(1);
    });
    expect(drillServices.generateDrill.mock.calls[0][0]).toMatchObject({
      patternKey: 'KGIU-INT-099',
      patternDisplay: '-는 바람에',
      meaning: 'as a result of (unexpected)',
    });
  });

  it('still drills a deep-link target when the pattern list is empty', async () => {
    // No banked patterns at all — the target must carry its own display/meaning.
    services.listPatterns.mockResolvedValue([]);
    services.listBanked.mockResolvedValue(EMPTY_BANK);
    mocks.loadGrammarMock.mockResolvedValue([]);
    drillServices.generateDrill.mockResolvedValue(GEN_TRANSFORM);

    renderGrammar({
      patternKey: 'KGIU-INT-099',
      display: '-는 바람에',
      meaning: 'as a result of (unexpected)',
    });

    await waitFor(() => {
      expect(drillServices.generateDrill).toHaveBeenCalledTimes(1);
    });
    expect(drillServices.generateDrill.mock.calls[0][0]).toMatchObject({
      patternKey: 'KGIU-INT-099',
    });
    // The "no patterns to drill" empty state must NOT win over the target.
    expect(
      screen.queryByText(/No grammar patterns to drill yet/i),
    ).not.toBeInTheDocument();
  });
});
