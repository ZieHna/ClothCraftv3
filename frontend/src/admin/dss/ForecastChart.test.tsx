import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { DssForecastRow, DssHistoryRow } from '../../api/adminDss';
import { ForecastChart } from './ForecastChart';

const history: DssHistoryRow[] = [
  { weekStart: '2026-10-05', units: 10, censored: false },
  { weekStart: '2026-10-12', units: 4, censored: true },
  { weekStart: '2026-10-19', units: 12, censored: false },
];
const row = (weekStart: string, h: number, over: Partial<DssForecastRow> = {}): DssForecastRow => ({
  weekStart,
  h,
  yhat: 11.25,
  lo80: 5,
  hi80: 18,
  lo95: 3,
  hi95: 22,
  method: 'bottom_up',
  flags: [],
  censored: false,
  ...over,
});
const rows = [row('2026-10-26', 1), row('2026-11-02', 2, { lo80: null, hi80: null })];

describe('ForecastChart', () => {
  it('draws the actuals, the forecast, the ranges and a distinct mark for the stock-out week', () => {
    render(<ForecastChart history={history} rows={rows} subject="Total" simulated={false} historyStatus={null} />);
    expect(screen.getByRole('img', { name: /Weekly units: Total/ })).toBeInTheDocument();
    expect(screen.getByTestId('band95')).toBeInTheDocument();
    expect(screen.queryByTestId('band80')).toBeNull(); // only one week has an 80% range: nothing to draw as a band
    expect(screen.getAllByTestId('stockout-marker')).toHaveLength(1);
    expect(screen.getByTestId('chart-key')).toHaveTextContent('Stock-out week (sales understated)');
    expect(screen.getByTestId('forecast-method')).toHaveTextContent('Sum of the product forecasts');
    expect(screen.getByTestId('kind-badge')).toHaveTextContent('REAL DATA');
  });

  it('shows the same numbers as a table, with the badge in the caption and the stock-out week in words', () => {
    render(<ForecastChart history={history} rows={rows} subject="Women Tee" simulated={true} historyStatus={null} />);
    fireEvent.click(screen.getByTestId('chart-toggle'));
    const table = within(screen.getByTestId('chart-table')).getByRole('table');
    expect(within(table).getByText('SIMULATED DATA')).toBeInTheDocument();
    expect(screen.getByTestId('table-stockout')).toHaveTextContent('Stock-out week');
    expect(screen.getAllByTestId('table-row-actual')).toHaveLength(3);
    const forecastRows = screen.getAllByTestId('table-row-forecast');
    expect(forecastRows[0]).toHaveTextContent('Forecast 11.3');
    expect(forecastRows[0]).toHaveTextContent('5 to 18');
    expect(forecastRows[1]).toHaveTextContent('—'); // an interval the engine could not make is a dash, not 0
    expect(screen.queryByTestId('chart-svg')).toBeNull();
    expect(screen.getByTestId('chart-toggle')).toHaveTextContent('Show as a chart');
  });

  it('says why there is no history when the server cannot give it', () => {
    render(<ForecastChart history={null} rows={rows} subject="CROP" simulated={false} historyStatus={{ code: 'history_unavailable', message: 'The type mapping is not proven.' }} />);
    expect(screen.getByTestId('history-status')).toHaveTextContent('The type mapping is not proven.');
    expect(screen.queryByTestId('stockout-marker')).toBeNull();
  });
});
