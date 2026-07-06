/**
 * AskAboutThisButton (F-020) — the "Ask about this" → Chat seed handoff.
 *
 * Rendered inside a real MemoryRouter with a probe route at `/chat`, so the
 * assertion covers the actual navigation + router-state payload rather than
 * a mocked `useNavigate` — the probe sees exactly what Chat will see.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { JSX } from 'react';
import { AskAboutThisButton } from './AskAboutThisButton';
import { readChatSeedState } from '../lib/askSeed';

/** Lands at `/chat` and prints the router state the navigation carried. */
function ChatStateProbe(): JSX.Element {
  const location = useLocation();
  const seed = readChatSeedState(location.state);
  return (
    <div data-testid="chat-probe">
      {seed === null ? 'no-seed' : JSON.stringify(seed)}
    </div>
  );
}

function renderButton(): void {
  render(
    <MemoryRouter initialEntries={['/mistakes']}>
      <Routes>
        <Route
          path="/mistakes"
          element={
            <AskAboutThisButton
              prompt="이 글의 내용과 같은 것은?"
              correctText="나 정답"
              explanation="정답은 나입니다."
              passage="한국의 전통 시장"
              userPick="가 오답"
            />
          }
        />
        <Route path="/chat" element={<ChatStateProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('AskAboutThisButton (F-020)', () => {
  it('renders an accessible button labelled "Ask about this"', () => {
    renderButton();
    const btn = screen.getByRole('button', { name: 'Ask about this' });
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute('type', 'button');
  });

  it('navigates to /chat carrying the built seed + topik_prep mode in router state', async () => {
    const user = userEvent.setup();
    renderButton();

    await user.click(screen.getByRole('button', { name: 'Ask about this' }));

    const probe = screen.getByTestId('chat-probe');
    expect(probe).not.toHaveTextContent('no-seed');
    const seed = JSON.parse(probe.textContent ?? 'null') as {
      seedText: string;
      mode: string;
    };
    expect(seed.mode).toBe('topik_prep');
    expect(seed.seedText).toContain('About this TOPIK question:');
    expect(seed.seedText).toContain('이 글의 내용과 같은 것은?');
    expect(seed.seedText).toContain('지문: 한국의 전통 시장');
    expect(seed.seedText).toContain('Correct answer: 나 정답');
    expect(seed.seedText).toContain('My answer: 가 오답 (incorrect)');
    expect(seed.seedText).toContain('Why: 정답은 나입니다.');
  });
});
