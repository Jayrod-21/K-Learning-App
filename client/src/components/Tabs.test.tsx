/**
 * Tabs — the W3C tabs contract (tablist/tab/tabpanel wiring, aria-selected,
 * roving tabindex), click + arrow-key/Home/End activation with wrap,
 * controlled vs uncontrolled selection, and the empty-tabs render-nothing
 * edge.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Tabs } from './Tabs';

const THREE_TABS = [
  { id: 'words', label: 'Words' },
  { id: 'grammar', label: 'Grammar' },
  { id: 'hanja', label: 'Hanja' },
];

function renderTabs(
  props: Partial<{
    active: string;
    onChange: (id: string) => void;
    defaultTab: string;
  }> = {},
): ReturnType<typeof render> {
  return render(
    <Tabs tabs={THREE_TABS} ariaLabel="Library sections" {...props}>
      {(activeId) => <div>PANEL {activeId.toUpperCase()}</div>}
    </Tabs>,
  );
}

describe('Tabs', () => {
  it('renders the tablist, tabs, and the active tabpanel with aria wiring', () => {
    renderTabs();

    expect(
      screen.getByRole('tablist', { name: 'Library sections' }),
    ).toBeInTheDocument();

    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual([
      'Words',
      'Grammar',
      'Hanja',
    ]);
    // First tab is active by default (no defaultTab given).
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[1]).toHaveAttribute('aria-selected', 'false');

    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveTextContent('PANEL WORDS');
    // Tab ↔ panel are wired both ways.
    expect(tabs[0]?.getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.getAttribute('aria-labelledby')).toBe(tabs[0]?.id);
    // Panel is keyboard-reachable even with no focusable content.
    expect(panel).toHaveAttribute('tabindex', '0');
  });

  it('switches tab and panel on click (uncontrolled)', async () => {
    const user = userEvent.setup();
    renderTabs();

    await user.click(screen.getByRole('tab', { name: 'Hanja' }));

    expect(screen.getByRole('tab', { name: 'Hanja' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tab', { name: 'Words' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
    expect(screen.getByRole('tabpanel')).toHaveTextContent('PANEL HANJA');
  });

  it('honors defaultTab in uncontrolled mode', () => {
    renderTabs({ defaultTab: 'grammar' });
    expect(screen.getByRole('tab', { name: 'Grammar' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tabpanel')).toHaveTextContent('PANEL GRAMMAR');
  });

  it('applies a roving tabindex: only the active tab is tabbable', async () => {
    const user = userEvent.setup();
    renderTabs({ defaultTab: 'grammar' });

    expect(screen.getByRole('tab', { name: 'Words' })).toHaveAttribute(
      'tabindex',
      '-1',
    );
    expect(screen.getByRole('tab', { name: 'Grammar' })).toHaveAttribute(
      'tabindex',
      '0',
    );

    // The roving stop moves with selection.
    await user.click(screen.getByRole('tab', { name: 'Hanja' }));
    expect(screen.getByRole('tab', { name: 'Hanja' })).toHaveAttribute(
      'tabindex',
      '0',
    );
    expect(screen.getByRole('tab', { name: 'Grammar' })).toHaveAttribute(
      'tabindex',
      '-1',
    );
  });

  it('moves selection AND focus with arrow keys, wrapping at the ends', async () => {
    const user = userEvent.setup();
    renderTabs();

    await user.click(screen.getByRole('tab', { name: 'Words' }));
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Grammar' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tab', { name: 'Grammar' })).toHaveFocus();

    // 2 → 1 → wrap to 3.
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'Hanja' })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    // Wrap 3 → 1.
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Words' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tabpanel')).toHaveTextContent('PANEL WORDS');
  });

  it('jumps to the ends with Home and End', async () => {
    const user = userEvent.setup();
    renderTabs({ defaultTab: 'grammar' });

    screen.getByRole('tab', { name: 'Grammar' }).focus();
    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Hanja' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tab', { name: 'Hanja' })).toHaveFocus();

    await user.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: 'Words' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('controlled: the active prop drives selection; clicks only notify', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(
      <Tabs
        tabs={THREE_TABS}
        ariaLabel="Library sections"
        active="words"
        onChange={onChange}
      >
        {(activeId) => <div>PANEL {activeId.toUpperCase()}</div>}
      </Tabs>,
    );

    await user.click(screen.getByRole('tab', { name: 'Hanja' }));

    // The parent was told...
    expect(onChange).toHaveBeenCalledWith('hanja');
    // ...but selection does NOT move until the parent updates the prop.
    expect(screen.getByRole('tab', { name: 'Words' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tabpanel')).toHaveTextContent('PANEL WORDS');

    rerender(
      <Tabs
        tabs={THREE_TABS}
        ariaLabel="Library sections"
        active="hanja"
        onChange={onChange}
      >
        {(activeId) => <div>PANEL {activeId.toUpperCase()}</div>}
      </Tabs>,
    );
    expect(screen.getByRole('tab', { name: 'Hanja' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tabpanel')).toHaveTextContent('PANEL HANJA');
  });

  it('fires onChange in uncontrolled mode too (notification)', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderTabs({ onChange });

    await user.click(screen.getByRole('tab', { name: 'Grammar' }));

    expect(onChange).toHaveBeenCalledWith('grammar');
    expect(screen.getByRole('tab', { name: 'Grammar' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('renders nothing for an empty tabs array', () => {
    const { container } = render(
      <Tabs tabs={[]} ariaLabel="Empty">
        {() => <div>NEVER</div>}
      </Tabs>,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });
});
