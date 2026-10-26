import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { DssBacktestRow } from '../../api/adminDss';
import { AccuracyTable } from './AccuracyTable';

const bt = (policy: string, over: Partial<DssBacktestRow> = {}): DssBacktestRow => ({
  level: 'total',
  key: 'total',
  policy,
  horizon: 'all',
  weeks: 'all',
  n: 90,
  nWithInterval: 90,
  mae: 5.3062,
  wape: 45.0956,
  bias: -19.74,
  cov80: 75.5556,
  cov95: 85.5556,
  chosen: policy === 'chosen',
  ...over,
});
const rows = [bt('naive', { bias: -15.7098, wape: 64.6586 }), bt('snaive', { cov80: null, cov95: null }), bt('chosen'), bt('ma4', { bias: -5.9364 })];

describe('AccuracyTable', () => {
  it('lists the chosen row first, marks baselines, and says out loud that the forecast under-predicts', () => {
    render(<AccuracyTable rows={rows} subject="Total" simulated={false} chosenMethod="ets_croston" />);
    const lines = screen.getAllByTestId('accuracy-row');
    expect(lines.map((r) => r.getAttribute('data-policy'))).toEqual(['chosen', 'ma4', 'naive', 'snaive']);
    expect(lines[0]).toHaveTextContent('−19.7');
    expect(lines[0]).toHaveTextContent('45.1');
    expect(lines[1]).toHaveTextContent('Baseline');
    expect(lines[3]).toHaveTextContent('—'); // no interval, so no coverage: a dash
    expect(screen.getByTestId('accuracy-notes')).toHaveTextContent('it under-predicts');
    expect(screen.getByTestId('accuracy-notes')).toHaveTextContent('held only 75.6%');
    expect(screen.getByTestId('chosen-method')).toHaveTextContent('ETS with Croston');
    expect(screen.queryByTestId('accuracy-simulated')).toBeNull();
  });

  it('a simulated run says it demonstrates the method only, beside its badge', () => {
    render(<AccuracyTable rows={rows} subject="Total" simulated={true} chosenMethod={null} />);
    expect(screen.getByTestId('accuracy-simulated')).toHaveTextContent('Demonstrates the method only');
    expect(screen.getAllByText('SIMULATED DATA').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByTestId('chosen-method')).toBeNull();
  });

  it('shows the weeks scored, and explains a method scored on fewer weeks than the rest', () => {
    render(<AccuracyTable rows={[bt('chosen'), bt('naive'), bt('snaive', { n: 14, wape: 127.6, cov80: null, cov95: null })]} subject="Total" simulated={false} chosenMethod={null} />);
    expect(screen.getAllByTestId('weeks-scored').map((c) => c.textContent)).toEqual(['90', '90', '14']);
    expect(screen.getByTestId('fewer-weeks-note')).toHaveTextContent('Seasonal naive needs a forecast from the same week one year earlier, so it is scored only where one exists.');
  });

  it('has no footnote when every method is scored on the same weeks', () => {
    render(<AccuracyTable rows={[bt('chosen'), bt('naive')]} subject="Total" simulated={false} chosenMethod={null} />);
    expect(screen.queryByTestId('fewer-weeks-note')).toBeNull();
  });

  it('says nothing about a lean when the bias is small', () => {
    render(<AccuracyTable rows={[bt('chosen', { bias: 1.2, cov80: 80, cov95: 95 })]} subject="Total" simulated={false} chosenMethod={null} />);
    expect(screen.getByTestId('accuracy-notes')).toHaveTextContent('no clear lean');
    expect(screen.getByTestId('accuracy-notes')).not.toHaveTextContent('leans low');
  });
});
