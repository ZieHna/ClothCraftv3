import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../api/adminDss';
import { ApiError } from '../../api/client';
import { ForecastPage } from './ForecastPage';

vi.mock('../../api/adminDss');
const mocked = vi.mocked(api);

const ref = (simulated: boolean): api.DssRunRef => ({
  id: simulated ? '9' : '1',
  kind: simulated ? 'simulated' : 'real',
  simulated,
  notice: simulated ? 'Simulated data: demonstrates the method, not real-world accuracy.' : null,
  asOf: '2026-10-26',
  engineVersion: 'B8-S4',
  closedRule: 'closed_state',
  closedRuleText: 'Closed',
  trigger: 'manual',
  finishedAt: '2026-10-26T11:01:29Z',
  ageDays: 0,
  stale: false,
});
const summary = (simulated: boolean): api.DssRunSummary => ({
  ...ref(simulated),
  state: 'done',
  startedAt: null,
  durationS: 59.6,
  requestedByName: null,
  headline: { orderNow: 0, alertsCritical: 1, alertsWarning: 3, forecastStatus: 'ok', segmentsStatus: 'ok', trend: null },
});
/** A resolved API answer. The mocked functions are typed per route, so the envelope is cast once, here. */
const ok = (data: unknown) => Promise.resolve({ data, simulation: null }) as never;
const forecast = (over: Partial<api.DssForecast> = {}): api.DssForecast => ({
  run: ref(false),
  level: 'total',
  key: 'total',
  dataStatus: null,
  historyStatus: null,
  rows: [{ weekStart: '2026-10-26', h: 1, yhat: 14.6, lo80: 5.6, hi80: 27.2, lo95: 3.6, hi95: 33.6, method: 'bottom_up', flags: [], censored: false }],
  history: [{ weekStart: '2026-10-19', units: 39, censored: false }],
  ...over,
});
const backtest = (): api.DssBacktest => ({
  run: ref(false),
  total: 1,
  page: 1,
  pageSize: 100,
  rows: [{ level: 'total', key: 'total', policy: 'chosen', horizon: 'all', weeks: 'all', n: 90, nWithInterval: 90, mae: 5.3, wape: 45.1, bias: -19.7, cov80: 75.6, cov95: 85.6, chosen: true }],
});
const page = () =>
  render(
    <MemoryRouter>
      <ForecastPage />
    </MemoryRouter>,
  );

const restockRow = (over: Partial<api.DssRestockRow> = {}): api.DssRestockRow => ({
  productId: '1', productTemplateId: '19', sku: 'S', product: 'Baby Dress', garmentType: 'DRESS', size: 'M', color: 'Gray', onHand: 9, reserved: 0, free: 9, incoming: 0,
  weeklyDemand: 0.02, daysLeft: null, leadDays: 7, suggestedQty: 0, orderNow: false, stockoutBeforeArrival: false, urgency: 'ok', ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  mocked.getDssRestock.mockReturnValue(ok({ run: ref(false), rows: [restockRow()], total: 1, page: 1, pageSize: 100, counts: { stockoutBeforeArrival: 0, orderNow: 0, plan: 0, ok: 1, noForecast: 0 } }));
  mocked.getDssRun.mockReturnValue(ok({ run: { ...summary(false), selection: { chosen: 'ets_croston' } } }));
  mocked.getDssBacktest.mockReturnValue(ok(backtest()));
});

describe('ForecastPage', () => {
  it('shows only the real block when there is no simulated run', async () => {
    mocked.getDssOverview.mockReturnValue(ok({ real: summary(false), simulated: null, queue: null }));
    mocked.getDssForecast.mockReturnValue(ok(forecast()));
    page();
    expect(await screen.findByTestId('forecast-chart')).toBeInTheDocument();
    expect(screen.getByTestId('forecast-real')).toBeInTheDocument();
    expect(screen.queryByTestId('forecast-simulated')).toBeNull();
    expect(await screen.findByTestId('accuracy')).toBeInTheDocument();
    expect(mocked.getDssForecast).toHaveBeenCalledWith({ run: '1', level: 'total', key: undefined }, expect.anything());
  });

  it('explains the forecast in plain words from the numbers, defines the terms, and gives recommendations with their reasons', async () => {
    mocked.getDssOverview.mockReturnValue(ok({ real: summary(false), simulated: null, queue: null }));
    mocked.getDssForecast.mockReturnValue(ok(forecast()));
    page();
    expect(await screen.findByTestId('forecast-meaning')).toBeInTheDocument();
    expect(screen.getByTestId('meaning-expected')).toHaveTextContent('ClothCraft is expected to sell about 14.6 garments a week from 26 Oct 2026 to 26 Oct 2026 (the next week)');
    expect(screen.getByTestId('meaning-uncertainty')).toHaveTextContent('not guaranteed results');
    expect(screen.getByTestId('meaning-reminder')).toHaveTextContent('about 45.1% of the units sold');
    expect(await screen.findByTestId('accuracy-meaning')).toHaveTextContent('under-predicts');
    const terms = screen.getAllByTestId('term-list').map((t) => t.textContent).join(' ');
    for (const word of ['WAPE (Weighted Absolute Percentage Error)', 'MAE (Mean Absolute Error)', 'Bias', '80% range', '95% range', 'Forecast horizon', 'Backtest', 'Baseline']) expect(terms).toContain(word);
    const recs = await screen.findByTestId('recommendations');
    expect(recs).toHaveTextContent('What the data shows');
    expect(recs).toHaveTextContent('Recommended action');
    expect(recs).toHaveTextContent('Why');
    expect(recs).toHaveTextContent('nothing is ordered or changed until you decide');
  });

  it('changes the explanation and the recommendations with the selected view', async () => {
    mocked.getDssOverview.mockReturnValue(ok({ real: summary(false), simulated: null, queue: null }));
    mocked.getDssForecast.mockImplementation(((q: { level: string; key?: string }) => ok(forecast({ level: q.level as api.DssForecastLevel, key: q.key ?? 'total', rows: [{ ...forecast().rows[0], yhat: q.level === 'total' ? 14.6 : 0.4 }] }))) as never);
    mocked.getDssForecastKeys.mockReturnValue(ok({ run: ref(false), level: 'product', keys: [{ level: 'product', key: '19', label: 'Baby Dress' }] }));
    page();
    expect(await screen.findByTestId('meaning-expected')).toHaveTextContent('about 14.6 garments a week');
    fireEvent.click(screen.getByLabelText('Product'));
    await waitFor(() => expect(screen.getByTestId('meaning-expected')).toHaveTextContent('Baby Dress is expected to sell less than one unit a week (about one every 3 weeks)'));
    await waitFor(() => expect(screen.getByTestId('recommendations')).toHaveTextContent('Baby Dress'));
    expect(mocked.getDssForecast).toHaveBeenCalledWith({ run: '1', level: 'product', key: '19' }, expect.anything());
  });

  it("shows the engine's own sentence when there is not enough history", async () => {
    mocked.getDssOverview.mockReturnValue(ok({ real: summary(false), simulated: null, queue: null }));
    mocked.getDssForecast.mockReturnValue(ok(forecast({ rows: [], dataStatus: { code: 'not_enough_history', message: 'Not enough weeks with sales to forecast (16 needed).' } })));
    page();
    expect(await screen.findByTestId('forecast-status')).toHaveTextContent('Not enough weeks with sales to forecast (16 needed).');
    expect(screen.queryByTestId('forecast-chart')).toBeNull();
  });

  it('an error shows its message with Retry, Retry asks again, and each block asks for its own run', async () => {
    mocked.getDssOverview.mockReturnValue(ok({ real: summary(false), simulated: summary(true), queue: null }));
    mocked.getDssForecast.mockRejectedValueOnce(new ApiError(502, 'upstream_unavailable', 'The shop service is not answering.')).mockReturnValue(ok(forecast()));
    page();
    await waitFor(() => expect(screen.getAllByTestId('dss-error').length).toBeGreaterThan(0));
    expect(screen.getAllByTestId('dss-error')[0]).toHaveTextContent('The shop service is not answering.');
    fireEvent.click(screen.getAllByRole('button', { name: 'Retry' })[0]);
    await waitFor(() => expect(screen.getAllByTestId('forecast-chart').length).toBe(2));
    expect(screen.getByTestId('forecast-simulated')).toBeInTheDocument();
    const asked = mocked.getDssForecast.mock.calls.map((c) => c[0].run);
    expect(asked).toContain('1');
    expect(asked).toContain('9');
  });

  it('no real run: says so and points to the Overview', async () => {
    mocked.getDssOverview.mockReturnValue(ok({ real: null, simulated: null, queue: null }));
    page();
    expect(await screen.findByTestId('empty-real')).toHaveTextContent('No DSS run yet');
    expect(screen.getByRole('link', { name: /Overview/ })).toHaveAttribute('href', '/admin/dss');
  });
});
