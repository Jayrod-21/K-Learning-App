/**
 * Today — loading + rendered + interaction.
 *
 * We mock `useEndpointOrMock` to control the data the screen reads. Both
 * fetches (today plan + diagnostic snapshot) share the same hook, so we
 * dispatch on the `key` arg. As of Pass 5 both fetches are realFn-backed
 * (`/plan/today` + `/diagnostic/latest`); the hook mock here stands in for
 * either source, so the screen assertions hold regardless of which resolved.
 *
 * Interaction: clicking the Review queue card navigates to /review.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { TodayPlan, DiagnosticSnapshot } from '../types/domain';

// Hook mock — control loading + data per key. `vi.hoisted` is necessary
// because `vi.mock` is hoisted above imports; sharing mutable state requires
// the holder to be hoisted too, otherwise the factory hits TDZ.
const hoisted = vi.hoisted(() => {
  type HookState =
    | { kind: 'loading' }
    | { kind: 'data'; data: unknown };
  return {
    today: { state: { kind: 'loading' } as HookState },
    diag: { state: { kind: 'loading' } as HookState },
  };
});

vi.mock('../hooks/useEndpointOrMock', () => ({
  useEndpointOrMock: (key: string) => {
    const s = key === 'today' ? hoisted.today.state : hoisted.diag.state;
    if (s.kind === 'loading') {
      return {
        data: null,
        loading: true,
        error: null,
        isMock: false,
        refetch: () => undefined,
      };
    }
    return {
      data: s.data,
      loading: false,
      error: null,
      isMock: true,
      refetch: () => undefined,
    };
  },
}));

// Pull the page AFTER the hook mock is set up so the screen wires to it.
import { Today } from './Today';

const PLAN: TodayPlan = {
  reviewCount: 24,
  reading: { title: '도시화와 환경', mins: 3, level: 'L4', tag: 'Reading' },
  listening: {
    title: 'KBS — 재택근무 확산',
    mins: 4,
    level: 'L3→L4',
    tag: 'Listening',
  },
  writing: {
    title: 'Paragraph in 합쇼체',
    mins: 8,
    level: 'L4',
    tag: 'Writing',
  },
  largestGap: 'Listening',
};

const SNAP: DiagnosticSnapshot = {
  dimensions: [
    { key: 'reading', label: 'Reading', kr: '읽기', score: 62, note: 'n' },
    // Pass 5 adds grammar to the dimension union; the snapshot card renders it
    // generically (SkillsCompare keys on the string `key`), so it must survive.
    { key: 'grammar', label: 'Grammar', kr: '문법', score: 48, note: 'g' },
  ],
  references: [
    { id: 'L4', label: 'TOPIK 4', kr: '4급', value: 55 },
  ],
  defaultRef: 'L4',
  goals: [],
};

function renderTodayAt(path = '/'): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<Today />} />
        <Route path="/review" element={<div>REVIEW PAGE</div>} />
        <Route path="/writing" element={<div>WRITING PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Today', () => {
  it('renders loading skeletons while both fetches are pending', () => {
    hoisted.today.state = { kind: 'loading' };
    hoisted.diag.state = { kind: 'loading' };

    renderTodayAt();
    // Skeleton cards announce aria-busy="true".
    const busy = document.querySelectorAll('[aria-busy="true"]');
    expect(busy.length).toBeGreaterThan(0);
  });

  it('renders the Korean title, review queue, and three task cards when loaded', () => {
    hoisted.today.state = { kind: 'data', data: PLAN };
    hoisted.diag.state = { kind: 'data', data: SNAP };

    renderTodayAt();

    expect(screen.getByText('오늘 · Today')).toBeInTheDocument();
    expect(screen.getByText('24 cards due')).toBeInTheDocument();
    expect(screen.getByText('도시화와 환경')).toBeInTheDocument();
    expect(screen.getByText('KBS — 재택근무 확산')).toBeInTheDocument();
    expect(screen.getByText(/Paragraph in/)).toBeInTheDocument();
    // Largest gap pill on Listening tile.
    expect(screen.getByText('Largest gap')).toBeInTheDocument();
    // Register drill pill on Writing tile.
    expect(screen.getByText('Register drill')).toBeInTheDocument();
  });

  it('navigates to /review when the review queue card is clicked', async () => {
    hoisted.today.state = { kind: 'data', data: PLAN };
    hoisted.diag.state = { kind: 'data', data: SNAP };

    const user = userEvent.setup();
    renderTodayAt();

    const cta = screen.getByRole('button', {
      name: /Open review — 24 cards due/,
    });
    await user.click(cta);

    expect(screen.getByText('REVIEW PAGE')).toBeInTheDocument();
  });

  it('navigates to /writing when the Writing task tile is clicked (F-001)', async () => {
    hoisted.today.state = { kind: 'data', data: PLAN };
    hoisted.diag.state = { kind: 'data', data: SNAP };

    const user = userEvent.setup();
    renderTodayAt();

    // The tile is one big <button>; its accessible name includes the task
    // title. Previously this tile pointed at /grammar (no Writing screen
    // existed) — it must now land on the real /writing grader.
    const tile = screen.getByRole('button', { name: /Paragraph in/ });
    await user.click(tile);

    expect(screen.getByText('WRITING PAGE')).toBeInTheDocument();
  });

  it('moves the "Largest gap" pill onto the modality named by largestGap', () => {
    // Writing is the weakest skill today → its tile wears "Largest gap" and the
    // "Register drill" copy is suppressed (gap precedence over the default).
    hoisted.today.state = {
      kind: 'data',
      data: { ...PLAN, largestGap: 'Writing' },
    };
    hoisted.diag.state = { kind: 'data', data: SNAP };

    renderTodayAt();

    expect(screen.getByText('Largest gap')).toBeInTheDocument();
    expect(screen.queryByText('Register drill')).not.toBeInTheDocument();
  });

  it('omits a task tile whose server task is null (empty corpus)', () => {
    hoisted.today.state = {
      kind: 'data',
      data: { ...PLAN, reading: null },
    };
    hoisted.diag.state = { kind: 'data', data: SNAP };

    renderTodayAt();

    // Reading tile gone; listening + writing still render.
    expect(screen.queryByText('도시화와 환경')).not.toBeInTheDocument();
    expect(screen.getByText('KBS — 재택근무 확산')).toBeInTheDocument();
    expect(screen.getByText(/Paragraph in/)).toBeInTheDocument();
  });
});
