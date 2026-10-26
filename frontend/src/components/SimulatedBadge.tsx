import type { Simulation } from '../api/types';

/** Shown wherever API data is simulated. Renders nothing when the response says the data is real. */
export function SimulatedBadge({ simulation, className = '' }: { simulation: Simulation | null; className?: string }) {
  if (!simulation) return null;
  return (
    <span
      title={simulation.note}
      className={`inline-flex items-center rounded-sm border border-tan bg-cream px-2 py-0.5 text-xs font-semibold uppercase tracking-widest text-brown-dark ${className}`}
    >
      {simulation.label}
    </span>
  );
}
