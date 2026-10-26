import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../api/adminDss';
import { ApiError } from '../../api/client';
import { OverviewPage } from './OverviewPage';

vi.mock('../../api/adminDss');
const mocked = vi.mocked(api);
const ok = (data: unknown) => Promise.resolve({ data, simulation: null }) as never;
const page = () =>
  render(
    <MemoryRouter>
      <OverviewPage />
    </MemoryRouter>,
  );
const button = () => screen.getByTestId('run-now-button');

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  mocked.getDssOverview.mockReturnValue(ok({ real: null, simulated: null, queue: null }));
  mocked.getDssRuns.mockReturnValue(ok({ runs: [], total: 0, page: 1, pageSize: 10 }));
});
afterEach(() => vi.useRealTimers());

const settle = () => act(async () => {
  await vi.advanceTimersByTimeAsync(0);
});

describe('Run now: the loading indicator follows the real run', () => {
  it('shows the indicator and "Running…" at once, disables the button, and a second click starts nothing', async () => {
    let release: (v: unknown) => void = () => undefined;
    mocked.startRunNow.mockReturnValue(new Promise((resolve) => (release = resolve)) as never);
    page();
    await settle();
    expect(button()).toHaveTextContent('Run now');
    expect(screen.queryByTestId('run-progress')).toBeNull();
    fireEvent.click(button());
    expect(button()).toHaveTextContent('Running…');
    expect(button()).toBeDisabled();
    expect(screen.getByTestId('run-progress')).toHaveTextContent('Sending your request to the server');
    fireEvent.click(button());
    expect(mocked.startRunNow).toHaveBeenCalledTimes(1);
    await act(async () => release({ data: { requestId: '5', state: 'queued' } }));
  });

  it('keeps going while queued and running, and stops only when the server says the run is done', async () => {
    mocked.startRunNow.mockReturnValue(ok({ requestId: '5', state: 'queued' }));
    mocked.getRunRequest.mockReturnValueOnce(ok({ requestId: '5', state: 'running', runId: null, detail: null })).mockReturnValue(ok({ requestId: '5', state: 'done', runId: '7', detail: null }));
    page();
    await settle();
    fireEvent.click(button());
    await settle();
    expect(screen.getByTestId('run-progress')).toHaveTextContent('Request queued');
    await act(async () => void (await vi.advanceTimersByTimeAsync(2000)));
    expect(screen.getByTestId('run-progress')).toHaveTextContent('Running DSS analysis on the shop’s real data');
    expect(button()).toBeDisabled();
    await act(async () => void (await vi.advanceTimersByTimeAsync(3000)));
    expect(screen.queryByTestId('run-progress')).toBeNull();
    expect(button()).toHaveTextContent('Run now');
    expect(button()).toBeEnabled();
    expect(screen.getByTestId('run-now-status')).toHaveTextContent('DSS run completed successfully');
    expect(mocked.getDssOverview.mock.calls.length).toBeGreaterThanOrEqual(2); // the results were asked for again
  });

  it('a failed run stops the indicator, says why, and lets you try again', async () => {
    mocked.startRunNow.mockReturnValue(ok({ requestId: '5', state: 'queued' }));
    mocked.getRunRequest.mockReturnValue(ok({ requestId: '5', state: 'failed', runId: '8', detail: 'This run failed: out of memory' }));
    page();
    await settle();
    fireEvent.click(button());
    await act(async () => void (await vi.advanceTimersByTimeAsync(2000)));
    expect(screen.queryByTestId('run-progress')).toBeNull();
    expect(screen.getByTestId('run-now-status')).toHaveTextContent('This run failed: out of memory');
    expect(screen.getByTestId('run-now-status')).toHaveTextContent('try again');
    expect(button()).toBeEnabled();
    expect(button()).toHaveTextContent('Run now');
  });

  it('a request the server refuses stops the indicator and leaves the button usable', async () => {
    mocked.startRunNow.mockRejectedValue(new ApiError(502, 'upstream_unavailable', 'The shop service is not answering.'));
    page();
    await settle();
    fireEvent.click(button());
    await settle();
    expect(screen.queryByTestId('run-progress')).toBeNull();
    expect(screen.getByTestId('run-now-status')).toHaveTextContent('The shop service is not answering.');
    expect(button()).toBeEnabled();
  });

  it('shows the indicator for a weekly run that was already going when the page opened', async () => {
    mocked.getDssOverview.mockReturnValue(ok({ real: null, simulated: null, queue: { requestId: null, state: 'running', runId: null, detail: null } }));
    page();
    await settle();
    expect(screen.getByTestId('run-progress')).toHaveTextContent('The weekly run is in progress');
    expect(button()).toBeDisabled();
  });
});
