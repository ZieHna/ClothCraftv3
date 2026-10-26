/** Display formatting only. Amounts come from the API already final; nothing is calculated here. Whole pesos show no centavos
 *  (₱349); anything else shows both digits (₱43.50, never ₱43.5: print fees are often half pesos). */
export function formatMoney(amount: number, currency: string): string {
  const whole = Number.isInteger(Math.round(amount * 100) / 100);
  return new Intl.NumberFormat('en-PH', { style: 'currency', currency, minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 }).format(amount);
}
