import { useId } from 'react';
import type { DssForecastLevel } from '../../api/adminDss';
import { expectedText, meaningText, periodText, rangeSentence, subjectName, trendText, type ForecastFacts } from './forecastInsight';
import { methodLabel, unitsText } from './forecastText';
import { METHOD_GLOSS, type TermKey } from './glossary';
import { KindBadge } from './RunBanner';
import { TermList } from './TermList';

interface Props {
  facts: ForecastFacts;
  level: DssForecastLevel;
  subject: string;
  simulated: boolean;
  /** the backtest's WAPE for this view, for the reminder; null when there is none */
  wape: number | null;
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * "What this forecast means", directly under the chart, close to its future part. Every number and sentence comes from the forecast rows of the view on
 * screen (forecastInsight.ts); a selection with no forecast never reaches this component.
 */
export function ForecastMeaning({ facts, level, subject, simulated, wape }: Props) {
  const id = useId();
  const who = capital(subjectName(level, subject));
  const range = rangeSentence(facts);
  const tiles: { label: string; value: string }[] = [
    { label: 'Expected sales', value: `${unitsText(facts.weeklyAvg)} a week` },
    { label: 'Forecast range (80%)', value: facts.lo80 !== null && facts.hi80 !== null ? `${unitsText(facts.lo80)} to ${unitsText(facts.hi80)} a week` : 'not available' },
    { label: 'Forecast period', value: periodText(facts) },
  ];
  const chartTerms: TermKey[] = ['range80', 'range95', 'horizon', ...(facts.stockoutWeeks > 0 ? (['stockout'] as TermKey[]) : [])];
  return (
    <section aria-labelledby={`${id}-h`} className="border border-tan bg-paper p-3 sm:p-4" data-testid="forecast-meaning">
      <h3 id={`${id}-h`} className="flex flex-wrap items-center gap-2 text-xl">
        <KindBadge simulated={simulated} /> <span>What this forecast means: {subject}</span>
      </h3>
      <dl className="mt-3 grid gap-2 sm:grid-cols-3" data-testid="forecast-tiles">
        {tiles.map((t) => (
          <div key={t.label} className="min-w-0 border border-tan bg-cream p-2">
            <dt className="text-xs text-muted">{t.label}</dt>
            <dd className="text-base font-semibold text-ink">{t.value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-3 space-y-2 text-sm" data-testid="forecast-meaning-text">
        <p data-testid="meaning-expected">
          <span className="font-semibold">Expected sales. </span>
          {who} is expected to sell {expectedText(facts.weeklyAvg, level)} from {periodText(facts)}, the forecast horizon.
        </p>
        <p data-testid="meaning-trend">
          <span className="font-semibold">Sales trend. </span>
          {trendText(facts)}
        </p>
        <p data-testid="meaning-uncertainty">
          <span className="font-semibold">How sure it is. </span>
          The shaded areas are possible ranges, not guaranteed results. {range ?? 'The engine did not make ranges for this selection.'}
        </p>
        <p data-testid="meaning-business">
          <span className="font-semibold">What it means for the business. </span>
          {meaningText(facts, level, simulated)}
        </p>
        <p data-testid="meaning-reminder" className="text-muted">
          <span className="font-semibold text-ink">Remember. </span>
          This is an estimate from {facts.historyWeeks > 0 ? `${facts.historyWeeks} weeks of past sales` : 'past sales'}
          {wape !== null ? `; when it was tested on past weeks, its misses added up to about ${unitsText(wape)}% of the units sold` : ''}. Real sales may differ.
        </p>
      </div>
      <div className="mt-3 border-t border-tan pt-3">
        <p className="text-sm font-semibold">Reading the chart</p>
        <TermList terms={chartTerms} label="Chart terms" className="mt-1" />
        {facts.methods.length > 0 && (
          <ul className="mt-1.5 space-y-1.5 text-sm" aria-label="Forecast method" data-testid="method-gloss">
            {facts.methods.map((m) => (
              <li key={m}>
                <span className="font-semibold">{methodLabel(m)}: </span>
                {METHOD_GLOSS[m] ?? 'The method the DSS used for these weeks.'}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
