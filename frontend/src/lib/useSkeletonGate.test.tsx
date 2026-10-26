import { act, render, renderHook, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoadingRegion } from '../components/skeleton/Skeleton';
import { resetSkeletonHandoff, useSkeletonGate, type Gate } from './useSkeletonGate';

/**
 * The timing rule of step B, with its real numbers passed in (the unit tests build with VITE_SKELETON_INSTANT, which makes the constants 0,
 * so each test names the numbers it means): a skeleton shows only after SHOW_DELAY (150 ms), stays at least MIN (600 ms) once it has
 * shown, never delays content that is ready, and an error or an empty answer does not wait for the minimum.
 */
const REAL = { delayMs: 150, minMs: 600 };
const at = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

beforeEach(() => {
  resetSkeletonHandoff();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

/** the gate over time, in 10 ms steps: what it said at each moment, with the data arriving (loading off) at `readyAt` ms */
function run(readyAt: number | null, options: { immediate?: boolean; total?: number } = {}) {
  const seen: [number, Gate][] = [];
  const hook = renderHook(({ loading, immediate }) => useSkeletonGate(loading, { ...REAL, immediate }), { initialProps: { loading: true, immediate: false } });
  let now = 0;
  seen.push([now, hook.result.current]);
  const total = options.total ?? 1500;
  while (now < total) {
    at(10);
    now += 10;
    if (readyAt !== null && now === readyAt) hook.rerender({ loading: false, immediate: options.immediate ?? false });
    seen.push([now, hook.result.current]);
  }
  return { seen, hook };
}
const firstAt = (seen: [number, Gate][], gate: Gate) => seen.find(([, g]) => g === gate)?.[0];
const lastAt = (seen: [number, Gate][], gate: Gate) => [...seen].reverse().find(([, g]) => g === gate)?.[0];

describe('the timing rule', () => {
  it('data that comes sooner than the delay shows no skeleton at all (it only reserves its room, unseen)', () => {
    const { seen } = run(100);
    expect(seen.some(([, g]) => g === 'skeleton')).toBe(false);
    expect(seen[0]![1]).toBe('wait');
    expect(firstAt(seen, 'content')).toBe(100); // content the moment the data is there
  });

  it('a slow load shows the skeleton after the delay, and keeps it for at least the minimum once it has shown', () => {
    const { seen } = run(300); // data at 300 ms: the skeleton appeared at 150, so it must stay until 150 + 600
    expect(firstAt(seen, 'skeleton')).toBe(150);
    expect(lastAt(seen, 'skeleton')).toBeGreaterThanOrEqual(740);
    expect(firstAt(seen, 'content')).toBe(750);
  });

  it('data that comes after the minimum has already passed is shown at once', () => {
    const { seen } = run(1000);
    expect(firstAt(seen, 'skeleton')).toBe(150);
    expect(firstAt(seen, 'content')).toBe(1000);
  });

  it('an error (or an empty answer) skips the minimum: it is shown the moment it is known', () => {
    const { seen } = run(300, { immediate: true });
    expect(firstAt(seen, 'skeleton')).toBe(150);
    expect(firstAt(seen, 'content')).toBe(300);
  });

  it('content that is ready on the first render is never delayed: no wait, no skeleton, no state change', () => {
    const states: Gate[] = [];
    const { rerender } = renderHook(
      ({ loading }) => {
        const gate = useSkeletonGate(loading, REAL);
        states.push(gate);
        return gate;
      },
      { initialProps: { loading: false } },
    );
    at(2000);
    rerender({ loading: false });
    expect(new Set(states)).toEqual(new Set(['content']));
  });

  it('after a skeleton, a second load (a retry) starts the delay again', () => {
    const { hook, seen } = run(1000);
    expect(seen[seen.length - 1]![1]).toBe('content');
    hook.rerender({ loading: true, immediate: false });
    expect(hook.result.current).toBe('wait');
    at(150);
    expect(hook.result.current).toBe('skeleton');
  });

  it('with the instant switch (both numbers 0, as in the unit tests and the real-mode scripts) a skeleton shows at once and leaves at once', () => {
    const { result, rerender } = renderHook(({ loading }) => useSkeletonGate(loading, { delayMs: 0, minMs: 0 }), { initialProps: { loading: true } });
    expect(result.current).toBe('skeleton'); // not 'wait': nothing is awaited
    rerender({ loading: false });
    expect(result.current).toBe('content');
  });
});

describe('the constants', () => {
  it('are 0 under the test switch (VITE_SKELETON_INSTANT=1, set for the unit tests in vite.config.ts) and defined in one file with the real numbers', async () => {
    const timing = await import('./skeletonTiming');
    expect(import.meta.env.VITE_SKELETON_INSTANT).toBe('1');
    expect([timing.SHOW_DELAY_MS, timing.MIN_SKELETON_MS, timing.STAFF_MIN_SKELETON_MS]).toEqual([0, 0, 0]);
    const source = readFileSync('src/lib/skeletonTiming.ts', 'utf8');
    expect(source).toMatch(/SHOW_DELAY_MS = instant \? 0 : 150;/);
    expect(source).toMatch(/MIN_SKELETON_MS = instant \? 0 : 600;/);
    expect(source).toMatch(/STAFF_MIN_SKELETON_MS = instant \? 0 : 300;/);
  });
});

describe('hand-off between skeletons (a lazy route\'s fallback, then the page\'s own)', () => {
  /** a page whose data is still loading, and which shows its own skeleton through the same gate */
  function Page({ loading }: { loading: boolean }) {
    const gate = useSkeletonGate(loading, REAL);
    return gate === 'content' ? (
      <p>the page</p>
    ) : (
      <LoadingRegion gate={gate} label="Loading the page…" data-testid="page-skeleton">
        …
      </LoadingRegion>
    );
  }

  /** the route's Suspense fallback: visible after the delay, never held back */
  function Fallback() {
    const gate = useSkeletonGate(true, { delayMs: 150, minMs: 0, fallback: true });
    return gate === 'content' ? null : (
      <LoadingRegion gate={gate} label="Loading the route…" data-testid="fallback-skeleton">
        …
      </LoadingRegion>
    );
  }

  it('the page starts with its skeleton already showing (no blank moment), and the minimum counts from the FIRST appearance', () => {
    const view = render(<Fallback />);
    expect(screen.getByTestId('fallback-skeleton')).toHaveAttribute('data-skeleton', 'wait');
    at(400); // the fallback appeared at 150 ms
    expect(screen.getByTestId('fallback-skeleton')).toHaveAttribute('data-skeleton', 'skeleton');
    // the chunk arrives at 400 ms: the fallback goes and the page (still loading its data) takes over in the same commit
    view.rerender(<Page loading />);
    expect(screen.getByTestId('page-skeleton')).toHaveAttribute('data-skeleton', 'skeleton'); // not 'wait'
    // its data comes at 500 ms; the first skeleton appeared at 150 ms, so it may go at 750 ms, not at 1100 ms
    at(100);
    view.rerender(<Page loading={false} />);
    expect(screen.queryByText('the page')).not.toBeInTheDocument();
    at(240);
    expect(screen.queryByText('the page')).not.toBeInTheDocument(); // 740 ms
    at(20);
    expect(screen.getByText('the page')).toBeInTheDocument(); // 760 ms
  });

  it('a page skeleton that is up when the visitor clicks away does NOT hand over: the next page, with quick data, shows no skeleton at all', () => {
    const first = render(<Page loading />);
    at(400);
    expect(screen.getByTestId('page-skeleton')).toHaveAttribute('data-skeleton', 'skeleton');
    first.unmount();
    const next = render(<Page loading />); // within the grace window of the other one leaving
    expect(screen.getByTestId('page-skeleton')).toHaveAttribute('data-skeleton', 'wait');
    next.rerender(<Page loading={false} />);
    expect(screen.getByText('the page')).toBeInTheDocument(); // data ready inside the delay: straight to content
  });

  it('with nothing on screen to hand over, the page waits its own delay', () => {
    at(500); // let any earlier skeleton's hand-off window close
    render(<Page loading />);
    expect(screen.getByTestId('page-skeleton')).toHaveAttribute('data-skeleton', 'wait');
    at(150);
    expect(screen.getByTestId('page-skeleton')).toHaveAttribute('data-skeleton', 'skeleton');
  });
});
