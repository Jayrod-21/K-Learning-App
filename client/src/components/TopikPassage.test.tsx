/**
 * TopikPassage — the shared reading passage block for TOPIK items (B-008).
 *
 * Covers: the text renders inside the styled passage block, and hostile
 * markup in a server payload stays literal text (React escaping — the
 * component's threat-model guarantee).
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TopikPassage } from './TopikPassage';

describe('TopikPassage', () => {
  it('renders the passage text in the styled block', () => {
    const text =
      '도시의 도로는 대부분 아스팔트로 뒤덮여 있다. 그래서 비가 오면 도로가 물에 잠기는 일도 자주 발생한다.';
    render(<TopikPassage text={text} />);
    const el = screen.getByText(text);
    expect(el).toHaveClass('km-topik__passage');
    expect(el).toHaveClass('kr'); // Korean typography class
  });

  it('renders hostile markup as literal text, never HTML', () => {
    render(<TopikPassage text={'<img src=x onerror=alert(1)> 본문'} />);
    // The tag is visible as TEXT (escaped), and no <img> element was created.
    expect(
      screen.getByText(/<img src=x onerror=alert\(1\)> 본문/),
    ).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });
});
