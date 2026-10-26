import { Link } from 'react-router';
import { customizeUrl, garmentLabels, previewUrl, type PremadeDesign } from '../../designs/catalog';

/**
 * One premade design: its picture, name, style, what it is made for and one clear action. No price and no stock: a design template has
 * neither (the garment you choose next brings its own, from the shop). The picture is the design on a garment, drawn by the editor itself.
 */
export function DesignCard({ design }: { design: PremadeDesign }) {
  return (
    <li className="flex min-w-0 flex-col border border-tan bg-cream p-3 sm:p-4" data-testid="design-card" data-design={design.id}>
      <img src={previewUrl(design.id)} alt={design.previewAlt} width={400} height={400} loading="lazy" decoding="async" className="aspect-square w-full bg-white object-contain" />
      <h3 className="mt-3 text-2xl leading-tight">{design.name}</h3>
      <p className="text-sm font-medium text-brown-dark" data-testid="design-style">
        {design.style}
      </p>
      <p className="mt-1 text-sm text-muted">Made for {garmentLabels(design).join(', ')}.</p>
      {design.editable === 'layers' && <p className="mt-1 text-xs text-muted">Includes an illustration you can move and resize.</p>}
      <p className="mt-3 sm:mt-auto sm:pt-3">
        <Link to={customizeUrl(design.id)} className="btn btn-primary btn-small w-full sm:w-auto" aria-label={`Customize Design: ${design.name}`}>
          Customize Design
        </Link>
      </p>
    </li>
  );
}
