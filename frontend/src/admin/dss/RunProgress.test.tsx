import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PROGRESS_TEXT, RunProgress, WEEKLY_TEXT } from './RunProgress';

describe('RunProgress', () => {
  it.each(['starting', 'queued', 'running'] as const)('shows a spinner and one honest sentence while the request is %s', (phase) => {
    render(<RunProgress phase={phase} weeklyRunning={false} />);
    const box = screen.getByTestId('run-progress');
    expect(box).toHaveAttribute('role', 'status');
    expect(box).toHaveAttribute('aria-live', 'polite');
    expect(box).toHaveTextContent(PROGRESS_TEXT[phase] as string);
    expect(screen.getByTestId('run-spinner')).toBeInTheDocument();
  });

  it('claims no stage the API does not report: the running sentence names no step of the engine', () => {
    render(<RunProgress phase="running" weeklyRunning={false} />);
    expect(screen.getByTestId('run-progress')).toHaveTextContent('Running DSS analysis on the shop’s real data');
    expect(screen.getByTestId('run-progress').textContent).not.toMatch(/forecast|inventory|order history|recommendation/i);
  });

  it('stops turning for reduced motion, and the words stay', () => {
    render(<RunProgress phase="running" weeklyRunning={false} />);
    expect(screen.getByTestId('run-spinner').getAttribute('class')).toContain('motion-reduce:animate-none');
  });

  it('shows the weekly run too, and nothing when no run is going', () => {
    const { rerender } = render(<RunProgress phase="idle" weeklyRunning={true} />);
    expect(screen.getByTestId('run-progress')).toHaveTextContent(WEEKLY_TEXT);
    rerender(<RunProgress phase="idle" weeklyRunning={false} />);
    expect(screen.queryByTestId('run-progress')).toBeNull();
    rerender(<RunProgress phase="done" weeklyRunning={false} />);
    expect(screen.queryByTestId('run-progress')).toBeNull();
    rerender(<RunProgress phase="failed" weeklyRunning={false} />);
    expect(screen.queryByTestId('run-progress')).toBeNull();
  });
});
