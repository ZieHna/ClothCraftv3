import { useId } from 'react';
import type { DssBacktestRow } from '../../api/adminDss';
import { KindBadge } from './RunBanner';
import { accuracySentences } from './forecastInsight';
import { BASELINES, byPolicyOrder, methodLabel, percentText, SIMULATED_ACCURACY_TEXT, signedPercentText, unitsText } from './forecastText';
import type { TermKey } from './glossary';
import { TermList } from './TermList';

interface Props {
  /** the backtest rows for one subject, all horizons and all weeks */
  rows: DssBacktestRow[];
  subject: string;
  simulated: boolean;
  /** the method the backtest chose overall (the run's own words), when the run detail could be read */
  chosenMethod: string | null;
}

/** Methods scored on fewer weeks than the most-scored one, each with the reason in words. */
function fewerWeeksNotes(rows: DssBacktestRow[]): string[] {
  const most = Math.max(0, ...rows.map((r) => r.n));
  return rows
    .filter((r) => r.n < most)
    .map((r) =>
      r.policy === 'snaive'
        ? 'Seasonal naive needs a forecast from the same week one year earlier, so it is scored only where one exists.'
        : `${methodLabel(r.policy)} is scored only on the weeks where it made a forecast.`,
    );
}

/**
 * The backtest: how each forecasting method, and each simple baseline, would have done on weeks that had already happened. The numbers are the
 * engine's (WAPE, bias and coverage are percents; MAE is units a week); this table only lays them out. A simulated run says "demonstrates the method only".
 */
export function AccuracyTable({ rows, subject, simulated, chosenMethod }: Props) {
  const ids = useId();
  const plain = (text: string) => text.replace('%', '');
  const sorted = [...rows].sort(byPolicyOrder);
  const sentences = accuracySentences(sorted);
  const methodTerms: TermKey[] = sorted.some((r) => ['ets', 'ets_croston'].includes(r.policy)) ? ['ets', 'croston'] : [];
  const fewer = fewerWeeksNotes(sorted);
  return (
    <section aria-labelledby={`${ids}-h`} className="min-w-0" data-testid="accuracy">
      <h3 id={`${ids}-h`} className="flex flex-wrap items-center gap-2 text-xl">
        <KindBadge simulated={simulated} /> <span>How accurate is it? {subject}</span>
      </h3>
      {simulated && (
        <p className="mt-1 text-sm font-medium text-ink" data-testid="accuracy-simulated">
          {SIMULATED_ACCURACY_TEXT}
        </p>
      )}
      <TermList terms={['backtest', 'baseline']} label="Backtest terms" className="mt-1" />
      {chosenMethod && (
        <p className="mt-1 text-sm" data-testid="chosen-method">
          Method chosen by the backtest: <span className="font-medium">{methodLabel(chosenMethod)}</span>.
        </p>
      )}
      <div className="mt-2 border border-tan">
        <table className="w-full table-fixed border-collapse text-[11px] sm:text-sm" data-testid="accuracy-table">
          <caption className="border-b border-tan bg-paper p-2 text-left">
            <KindBadge simulated={simulated} /> <span className="font-medium">Backtest: {subject}</span>
            <span className="block text-muted">All horizons (1 to 8 weeks ahead), all weeks. WAPE, bias and the held columns are percents; MAE is units a week. {simulated ? SIMULATED_ACCURACY_TEXT : ''}</span>
          </caption>
          <thead className="bg-paper-warm text-left">
            <tr>
              <th scope="col" className="w-[22%] p-0.5 font-semibold sm:p-1.5">
                Method
              </th>
              <th scope="col" className="w-[14%] px-1 py-0.5 text-[10px] font-semibold sm:w-auto sm:p-1.5 sm:text-sm">
                Weeks scored
              </th>
              <th scope="col" className="px-1 py-0.5 text-[10px] font-semibold sm:p-1.5 sm:text-sm">
                WAPE %
              </th>
              <th scope="col" className="px-1 py-0.5 text-[10px] font-semibold sm:p-1.5 sm:text-sm">
                MAE
              </th>
              <th scope="col" className="px-1 py-0.5 text-[10px] font-semibold sm:p-1.5 sm:text-sm">
                Bias %
              </th>
              <th scope="col" className="px-1 py-0.5 text-[10px] font-semibold sm:p-1.5 sm:text-sm">
                80% held %
              </th>
              <th scope="col" className="px-1 py-0.5 text-[10px] font-semibold sm:p-1.5 sm:text-sm">
                95% held %
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.policy} className={`border-t border-tan align-top ${r.chosen ? 'bg-paper font-medium' : ''}`} data-testid="accuracy-row" data-policy={r.policy}>
                <th scope="row" className="p-0.5 text-left font-normal sm:p-1.5">
                  {methodLabel(r.policy)}
                  {r.policy === 'chosen' && <span className="block text-[10px] font-semibold uppercase sm:text-xs sm:tracking-wider">Chosen</span>}
                  {BASELINES.includes(r.policy) && <span className="block text-xs text-muted">Baseline</span>}
                </th>
                <td className="px-1 py-0.5 tabular-nums sm:p-1.5" data-testid="weeks-scored">{r.n}</td>
                <td className="p-0.5 tabular-nums sm:p-1.5">{plain(percentText(r.wape))}</td>
                <td className="p-0.5 tabular-nums sm:p-1.5">{unitsText(r.mae)}</td>
                <td className="p-0.5 tabular-nums sm:p-1.5">{plain(signedPercentText(r.bias))}</td>
                <td className="p-0.5 tabular-nums sm:p-1.5">{plain(percentText(r.cov80))}</td>
                <td className="p-0.5 tabular-nums sm:p-1.5">{plain(percentText(r.cov95))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {fewer.length > 0 && (
        <p className="mt-2 text-sm text-muted" data-testid="fewer-weeks-note">
          {Array.from(new Set(fewer)).join(' ')}
        </p>
      )}
      {sentences.length > 0 && (
        <div className="mt-3 border border-tan bg-paper p-3" data-testid="accuracy-meaning">
          <h4 className="text-lg">What these results mean</h4>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm" data-testid="accuracy-notes">
            {sentences.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="mt-3">
        <p className="text-sm font-semibold">What the columns mean</p>
        <TermList terms={['wape', 'mae', 'bias', 'held', 'weeksScored', ...methodTerms]} label="Column terms" className="mt-1" />
      </div>
    </section>
  );
}
