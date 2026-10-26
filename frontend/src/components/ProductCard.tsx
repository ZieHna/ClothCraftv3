import { Link } from 'react-router';
import type { ProductSummary, Simulation } from '../api/types';
import { formatMoney } from '../lib/format';
import { SimulatedBadge } from './SimulatedBadge';
import { StockBadge } from './StockBadge';

/**
 * One catalogue item. Name, price and stock status are shown exactly as the API sent them; nothing is computed here.
 * The whole card is one link to the product page (a "stretched" link on the name: one tab stop, a big click target).
 */
export function ProductCard({ product, currency, simulation, headingLevel = 3 }: { product: ProductSummary; currency: string; simulation: Simulation | null; headingLevel?: 2 | 3 }) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <li className="card-link relative flex flex-col border border-tan bg-cream p-4 hover:border-brown" data-testid="product-card">
      {/* only when the API says the data is simulated (never on the shop's own database) */}
      {simulation && (
        <div className="min-h-6">
          <SimulatedBadge simulation={simulation} />
        </div>
      )}
      <img src={product.image} alt="" width={320} height={320} loading="lazy" decoding="async" className="mt-2 aspect-square w-full object-contain" />
      <Heading className="mt-3 text-2xl leading-tight">
        <Link to={`/products/${product.id}`} className="no-underline after:absolute after:inset-0 after:content-['']">
          {product.name}
        </Link>
      </Heading>
      <p className="text-sm text-muted">
        {product.garmentType.name} · {product.group}
      </p>
      <p className="mt-2 text-lg font-semibold text-ink">{formatMoney(product.price, currency)}</p>
      <p className="mt-1">
        <StockBadge status={product.status} />
      </p>
    </li>
  );
}
