import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { DssRunRef } from '../../api/adminDss';
import { RunBanner } from './RunBanner';

const NOTICE = 'Simulated data: demonstrates the method, not real-world accuracy.';
const run = (over: Partial<DssRunRef> = {}): DssRunRef => ({
  id: '5',
  kind: 'real',
  simulated: false,
  notice: null,
  asOf: '2026-10-26',
  engineVersion: 'B8-S4',
  closedRule: 'closed_state',
  closedRuleText: 'Closed = orders in the Closed state',
  trigger: 'manual',
  finishedAt: '2026-10-26T06:07:00Z',
  ageDays: 0,
  stale: false,
  ...over,
});
const banner = () => screen.getByTestId('run-banner');

describe('RunBanner: what every DSS screen says about the run it shows', () => {
  it('a fresh real run: the REAL DATA badge, no notice, no stale mark, and the run facts', () => {
    render(<RunBanner run={run()} />);
    expect(within(banner()).getByTestId('kind-badge')).toHaveTextContent('REAL DATA');
    expect(within(banner()).getByTestId('kind-badge')).toHaveAttribute('data-simulated', 'false');
    expect(screen.queryByTestId('run-notice')).toBeNull();
    expect(screen.queryByTestId('stale-badge')).toBeNull();
    expect(screen.getByTestId('run-asof')).toHaveTextContent('2026-10-26');
    expect(screen.getByTestId('run-closed-rule')).toHaveTextContent('Closed = orders in the Closed state');
    expect(banner()).toHaveTextContent('B8-S4');
    expect(banner()).toHaveTextContent('Run now'); // started by
    expect(banner()).toHaveTextContent('14:07'); // 06:07 UTC is 14:07 in Manila
    expect(banner()).toHaveTextContent('today');
  });

  it("a simulated run: the SIMULATED DATA badge and the server's standing notice word for word", () => {
    render(<RunBanner run={run({ kind: 'simulated', simulated: true, notice: NOTICE, trigger: 'import' })} />);
    expect(within(banner()).getByTestId('kind-badge')).toHaveTextContent('SIMULATED DATA');
    expect(within(banner()).getByTestId('kind-badge')).toHaveAttribute('data-simulated', 'true');
    expect(screen.getByTestId('run-notice').textContent).toBe(NOTICE);
    expect(banner()).toHaveAttribute('data-kind', 'simulated');
    expect(banner()).toHaveTextContent('Imported bundle');
  });

  it("a stale run: the STALE mark, and the server's age sentence is shown as sent (added to the simulated notice when there is one)", () => {
    const age = 'This run is 9 days old; the figures may be out of date.';
    const { rerender } = render(<RunBanner run={run({ stale: true, ageDays: 9, notice: age })} />);
    expect(screen.getByTestId('stale-badge').textContent).toBe('Stale'); // shown in capitals by CSS (uppercase)
    expect(screen.getByTestId('run-notice').textContent).toBe(age);
    expect(banner()).toHaveTextContent('9 days ago');
    rerender(<RunBanner run={run({ kind: 'simulated', simulated: true, stale: true, ageDays: 9, notice: `${NOTICE} ${age}` })} />);
    expect(screen.getByTestId('kind-badge')).toHaveTextContent('SIMULATED DATA');
    expect(screen.getByTestId('run-notice').textContent).toBe(`${NOTICE} ${age}`);
  });

  it('a run with no known finish time or rule does not invent them', () => {
    render(<RunBanner run={run({ finishedAt: null, ageDays: null, asOf: null, engineVersion: null, closedRuleText: null })} />);
    expect(screen.queryByTestId('run-closed-rule')).toBeNull();
    expect(screen.getByTestId('run-asof')).toHaveTextContent('—');
    expect(banner()).toHaveTextContent('age unknown');
  });
});
