import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import type { DssRequestState } from '../../api/adminDss';
import { createRunNow, GIVE_UP_MS, TIMEOUT_TEXT, UNKNOWN_TEXT, type RunNowApi, type RunNowOptions, type RunNowState } from './useRunNow';

/**
 * Run now's timing (B8 S5a): the first poll 2 s after the 202, then 3 s, 5 s, then every 10 s and never faster; nothing asked while the tab is hidden;
 * a stop on done / failed / unknown, on unmount and after 10 minutes; a 409 is "follow the run that is going", not an error. Fake timers, a fake API.
 */
let hidden = false;
beforeEach(() => {
  hidden = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  delete (document as { hidden?: boolean }).hidden;
});

type Reply = { state: DssRequestState; runId?: string; detail?: string };
/** `replies` are the answers to successive polls; once they run out the request stays "running". */
function setup(replies: Reply[] = [], extra: RunNowOptions = {}, start?: RunNowApi['start']) {
  const states: RunNowState[] = [];
  const at: number[] = []; // when each poll was asked, ms after the 202
  let zero = 0;
  const api: RunNowApi = {
    start: start ?? vi.fn(async () => ({ requestId: '14' })),
    poll: vi.fn(async () => {
      at.push(Date.now() - zero);
      const next = replies.shift() ?? { state: 'running' as const };
      return { state: next.state, runId: next.runId ?? null, detail: next.detail ?? null };
    }),
  };
  const engine = createRunNow((s) => states.push(s), () => ({ api, ...extra }));
  return { engine, states, at, api, mark: () => (zero = Date.now()), last: () => states[states.length - 1] };
}
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe('polling pace', () => {
  it('asks 2 s, then 3 s, then 5 s after, then every 10 s (never faster)', async () => {
    const t = setup();
    await t.engine.start();
    t.mark();
    expect(t.last().phase).toBe('queued');
    await tick(1999);
    expect(t.at).toEqual([]); // nothing before 2 s
    await tick(40_000 - 1999);
    expect(t.at).toEqual([2000, 5000, 10_000, 20_000, 30_000, 40_000]);
    t.engine.dispose();
  });

  it('a second press while one is starting or followed asks the server once', async () => {
    const t = setup();
    void t.engine.start();
    await t.engine.start();
    await t.engine.start();
    expect(t.api.start).toHaveBeenCalledTimes(1);
    t.engine.dispose();
  });
});

describe('stopping', () => {
  it('done: reports the run once and asks nothing more', async () => {
    const onFinished = vi.fn();
    const t = setup([{ state: 'running' }, { state: 'done', runId: '7' }], { onFinished });
    await t.engine.start();
    t.mark();
    await tick(120_000);
    expect(t.api.poll).toHaveBeenCalledTimes(2);
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(onFinished).toHaveBeenCalledWith('done', '7');
    expect(t.last()).toMatchObject({ phase: 'done', runId: '7', message: null });
  });

  it("failed: shows the server's message", async () => {
    const onFinished = vi.fn();
    const t = setup([{ state: 'failed', runId: '8', detail: 'This run failed: RuntimeError: x' }], { onFinished });
    await t.engine.start();
    await tick(2000);
    expect(t.last()).toMatchObject({ phase: 'failed', runId: '8', message: 'This run failed: RuntimeError: x' });
    expect(onFinished).toHaveBeenCalledWith('failed', '8');
  });

  it('unknown: stops and says the request is no longer known', async () => {
    const t = setup([{ state: 'unknown' }]);
    await t.engine.start();
    await tick(60_000);
    expect(t.api.poll).toHaveBeenCalledTimes(1);
    expect(t.last()).toMatchObject({ phase: 'unknown', message: UNKNOWN_TEXT });
  });

  it('leaving the page stops it: no poll after dispose', async () => {
    const t = setup();
    await t.engine.start();
    await tick(2500);
    expect(t.api.poll).toHaveBeenCalledTimes(1);
    t.engine.dispose();
    await tick(120_000);
    expect(t.api.poll).toHaveBeenCalledTimes(1);
  });

  it('gives up after 10 minutes and says it is still running', async () => {
    const t = setup();
    await t.engine.start();
    await tick(GIVE_UP_MS + 60_000);
    expect(t.last()).toMatchObject({ phase: 'timeout', message: TIMEOUT_TEXT });
    const asked = (t.api.poll as ReturnType<typeof vi.fn>).mock.calls.length;
    await tick(120_000);
    expect(t.api.poll).toHaveBeenCalledTimes(asked);
  });
});

describe('a hidden tab', () => {
  it('asks nothing while hidden, and waits one full step after coming back', async () => {
    const t = setup();
    await t.engine.start();
    t.mark();
    await tick(1000);
    hidden = true;
    t.engine.visibility();
    await tick(60_000);
    expect(t.at).toEqual([]);
    hidden = false;
    t.engine.visibility(); // 61 s after the 202
    await tick(1999);
    expect(t.at).toEqual([]); // not at once
    await tick(1);
    expect(t.at).toEqual([63_000]); // one full first step (2 s) after coming back, because no poll had been made yet
    t.engine.dispose();
  });
});

describe('another run is already going (409)', () => {
  it("is not an error: the server's sentence is shown, onConflict fires, and the run that is going can be followed", async () => {
    const onConflict = vi.fn();
    const sentence = 'A DSS run is already queued or running. It appears here when it has finished.';
    const refuse = vi.fn(async () => {
      throw new ApiError(409, 'run_in_progress', sentence);
    });
    const t = setup([{ state: 'done', runId: '9' }], { onConflict }, refuse);
    await t.engine.start();
    expect(t.last()).toMatchObject({ phase: 'conflict', message: sentence });
    expect(onConflict).toHaveBeenCalledTimes(1);
    t.engine.follow('21', 'running');
    expect(t.last()).toMatchObject({ phase: 'running', requestId: '21' });
    await tick(2000);
    expect(t.last()).toMatchObject({ phase: 'done', requestId: '21', runId: '9' });
  });

  it('any other failure of the start is shown and ends the attempt', async () => {
    const t = setup([], {}, vi.fn(async () => {
      throw new ApiError(502, 'upstream_unavailable', 'The shop could not be reached.');
    }));
    await t.engine.start();
    expect(t.last()).toMatchObject({ phase: 'error', message: 'The shop could not be reached.' });
    await tick(60_000);
    expect(t.api.poll).not.toHaveBeenCalled();
  });
});
