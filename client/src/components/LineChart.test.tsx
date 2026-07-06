/**
 * LineChart — rendering across the data shapes the contract allows:
 * a normal multi-point series, the empty series ("No data yet", never a
 * broken chart), a single point (dot, no line), defensive non-finite
 * filtering, and the y-scale rules (% fixed at 0–100; counts auto-scaled
 * to a nice ceiling). Plus the hover layer's readout behaviour.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LineChart } from './LineChart';
import type { SeriesPoint } from '../types/domain';

const POINTS: SeriesPoint[] = [
  { date: '2026-06-08', value: 58 },
  { date: '2026-06-15', value: 66 },
  { date: '2026-06-22', value: 70 },
  { date: '2026-06-30', value: 74 },
];

function renderChart(
  points: SeriesPoint[],
  overrides: Partial<{ unit: string; metricLabel: string }> = {},
): ReturnType<typeof render> {
  return render(
    <LineChart
      points={points}
      unit={overrides.unit ?? '%'}
      metricLabel={overrides.metricLabel ?? 'Accuracy'}
      ariaLabel="Reading trend over the last 30 days"
    />,
  );
}

describe('LineChart', () => {
  it('renders an accessible SVG with a line, area, and one dot per point', () => {
    const { container } = renderChart(POINTS);

    expect(
      screen.getByRole('img', { name: 'Reading trend over the last 30 days' }),
    ).toBeInTheDocument();
    expect(container.querySelectorAll('polyline.km-linechart__line')).toHaveLength(1);
    expect(container.querySelectorAll('polygon.km-linechart__area')).toHaveLength(1);
    expect(container.querySelectorAll('circle.km-linechart__dot')).toHaveLength(
      POINTS.length,
    );
  });

  it('shows the friendly empty state (not a broken chart) for no points', () => {
    const { container } = renderChart([]);

    expect(screen.getByText('No data yet')).toBeInTheDocument();
    expect(container.querySelector('svg')).not.toBeInTheDocument();
  });

  it('renders a single point as a dot with no line or area', () => {
    const { container } = renderChart([{ date: '2026-06-30', value: 42 }]);

    expect(container.querySelectorAll('circle.km-linechart__dot')).toHaveLength(1);
    expect(container.querySelector('polyline')).not.toBeInTheDocument();
    expect(container.querySelector('polygon')).not.toBeInTheDocument();
  });

  it('drops non-finite values instead of corrupting the plot', () => {
    const { container } = renderChart([
      { date: '2026-06-08', value: 58 },
      { date: '2026-06-15', value: Number.NaN },
      { date: '2026-06-30', value: 74 },
    ]);

    expect(container.querySelectorAll('circle.km-linechart__dot')).toHaveLength(2);
    // A series that is ALL non-finite degrades to the empty state.
    const { container: c2 } = renderChart([
      { date: '2026-06-08', value: Number.POSITIVE_INFINITY },
    ]);
    expect(c2.querySelector('svg')).not.toBeInTheDocument();
  });

  it('fixes the y-axis at 0–100 for percent series', () => {
    renderChart([{ date: '2026-06-08', value: 12 }, { date: '2026-06-09', value: 14 }]);
    // Top tick reads 100 even though the data maxes at 14.
    expect(screen.getByText('100')).toBeInTheDocument();
  });

  it('auto-scales count series to a nice ceiling of the data max', () => {
    renderChart(
      [
        { date: '2026-06-08', value: 12 },
        { date: '2026-06-09', value: 35 },
      ],
      { unit: 'cards', metricLabel: 'Count' },
    );
    // max 35 → nice ceiling 50, half-tick 25.
    expect(screen.getByText('50')).toBeInTheDocument();
    expect(screen.getByText('25')).toBeInTheDocument();
  });

  it('defaults the readout to the latest point and follows focus', () => {
    renderChart(POINTS);

    const readout = screen.getByRole('status');
    expect(readout).toHaveTextContent('Jun 30 · 74%');

    // Each point is a keyboard-reachable button; focusing one moves the readout.
    const first = screen.getByRole('button', {
      name: 'Accuracy on Jun 8: 58%',
    });
    fireEvent.focus(first);
    expect(readout).toHaveTextContent('Jun 8 · 58%');
    fireEvent.blur(first);
    expect(readout).toHaveTextContent('Jun 30 · 74%');
  });

  it('thins markers to the endpoint beyond 16 points', () => {
    const many: SeriesPoint[] = Array.from({ length: 30 }, (_, i) => ({
      date: `2026-06-${String(i + 1).padStart(2, '0')}`,
      value: 40 + i,
    }));
    const { container } = renderChart(many);

    expect(container.querySelectorAll('circle.km-linechart__dot')).toHaveLength(1);
    // The hover layer still covers every point.
    expect(container.querySelectorAll('button.km-linechart__hit')).toHaveLength(30);
  });
});
