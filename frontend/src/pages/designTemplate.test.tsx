import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ColorId, ProductSummary, SizeId, Variant } from '../api/types';
import { getDesign } from '../designs/catalog';
import { defaultVariant, TemplateGarmentPicker, TemplateNote, TemplateStatus } from './designTemplate';

afterEach(() => vi.unstubAllGlobals());

const v = (color: ColorId, size: SizeId, status: Variant['status'] = 'in_stock'): Variant => ({ sku: `SKU-${color}-${size}`, color, size, price: 349, stock: status === 'out_of_stock' ? 0 : 5, status }) as Variant;
const colours = (ids: ColorId[]) => ids.map((id) => ({ id, name: id, hex: '#000000', image: `/${id}.webp` }));

describe('defaultVariant: where the editor starts for a design on a garment', () => {
  const night = getDesign('night-shift')!; // its own colour is black; it reads well on black and navy

  it('takes the design\'s own colour in size M when the garment has it', () => {
    const product = { variants: [v('white', 'M'), v('black', 'S'), v('black', 'M'), v('black', 'L')], colorOptions: colours(['white', 'black']) };
    expect(defaultVariant(product, night)?.sku).toBe('SKU-black-M');
  });

  it('falls back to a colour the design reads well on, then to any colour', () => {
    expect(defaultVariant({ variants: [v('white', 'M'), v('navy', 'M')], colorOptions: colours(['white', 'navy']) }, night)?.sku).toBe('SKU-navy-M');
    expect(defaultVariant({ variants: [v('white', 'M'), v('gray', 'M')], colorOptions: colours(['white', 'gray']) }, night)?.sku).toBe('SKU-white-M');
  });

  it('takes the middle size when M does not exist, and prefers what is in stock', () => {
    expect(defaultVariant({ variants: [v('black', 'XS'), v('black', 'S'), v('black', 'L')], colorOptions: colours(['black']) }, night)?.sku).toBe('SKU-black-S');
    expect(defaultVariant({ variants: [v('black', 'M', 'out_of_stock'), v('white', 'M')], colorOptions: colours(['black', 'white']) }, night)?.sku).toBe('SKU-white-M');
  });

  it('still returns something when everything is sold out, and nothing when there is no variant', () => {
    expect(defaultVariant({ variants: [v('black', 'M', 'out_of_stock')], colorOptions: colours(['black']) }, night)?.sku).toBe('SKU-black-M');
    expect(defaultVariant({ variants: [], colorOptions: [] }, night)).toBeUndefined();
  });
});

describe('TemplateNote', () => {
  it('says what the person starts from, what can be edited, that the premade design is never changed, and that nothing is saved as a draft', () => {
    render(<TemplateNote design={getDesign('night-shift')!} garmentTypeCode="TEE" garmentName="Men Crew Tee" />);
    const note = screen.getByTestId('design-template-note');
    expect(note).toHaveTextContent('Starting from the premade design Night Shift');
    expect(note).toHaveTextContent('Every part is editable');
    expect(note).toHaveTextContent('never changed');
    expect(note).toHaveTextContent('not saved as a draft');
    expect(screen.queryByTestId('design-template-fit')).toBeNull();
  });

  it('is honest about a design with a picture layer, and warns when the garment is not one the design was made for', () => {
    render(<TemplateNote design={getDesign('mountain-mist')!} garmentTypeCode="ONESIE" garmentName="Baby Onesie" />);
    expect(screen.getByTestId('design-template-note')).toHaveTextContent('one picture you can move, resize and rotate');
    expect(screen.getByTestId('design-template-fit')).toHaveTextContent('made for T-shirts');
    expect(screen.getByTestId('design-template-fit')).toHaveTextContent('Baby Onesie');
  });
});

describe('TemplateStatus', () => {
  it('says the design is opening, or the error with a link back', () => {
    const { rerender } = render(
      <MemoryRouter>
        <TemplateStatus snap={{ phase: 'loading' }} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Opening the design');
    rerender(
      <MemoryRouter>
        <TemplateStatus snap={{ phase: 'error', message: 'That design could not be loaded.' }} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('That design could not be loaded.');
    expect(screen.getByRole('link', { name: 'Back to all designs' })).toHaveAttribute('href', '/designs');
  });
});

describe('TemplateGarmentPicker: the real garments a design is made for', () => {
  const product = (id: string, name: string, code: string, price: number, status: ProductSummary['status'] = 'in_stock'): ProductSummary =>
    ({ id, name, group: 'Men', garmentType: { code, name: code }, price, image: `/api/catalogue/products/${id}/image?v=1`, colors: ['black'], sizes: ['M'], stock: 5, status }) as ProductSummary;
  const serve = (products: ProductSummary[]) =>
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ data: { currency: 'PHP', vatIncluded: true, groups: [], colors: [], sizes: [], count: products.length, garmentTypes: [], products }, simulation: null }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

  it('lists only garments of the design\'s types, with the shop\'s own price and stock, each leading to the editor with that garment', async () => {
    serve([product('m-tee', 'Men Crew Tee', 'TEE', 349), product('b-ones', 'Baby Onesie', 'ONESIE', 249), product('w-hood', 'Women Hoodie', 'HOOD', 899, 'low_stock'), product('k-jkt', 'Kids Jacket', 'JKT', 699)]);
    render(
      <MemoryRouter>
        <TemplateGarmentPicker design={getDesign('night-shift')!} />
      </MemoryRouter>,
    ); // Night Shift: TEE, LSLV, HOOD, VNECK
    const items = await screen.findAllByTestId('template-garment');
    expect(items.map((i) => within(i).getByRole('heading').textContent)).toEqual(['Men Crew Tee', 'Women Hoodie']);
    expect(items[0]).toHaveTextContent('₱349');
    expect(items[1]).toHaveTextContent('₱899');
    expect(within(items[0]!).getByRole('link')).toHaveAttribute('href', '/design?template=night-shift&product=m-tee');
  });

  it('says so when no garment in the shop fits, and when the garments cannot be loaded', async () => {
    serve([product('k-jkt', 'Kids Jacket', 'JKT', 699)]);
    const { unmount } = render(
      <MemoryRouter>
        <TemplateGarmentPicker design={getDesign('night-shift')!} />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/No garment in the shop fits this design/)).toBeInTheDocument();
    unmount();
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { code: 'down', message: 'The shop is not available right now.' } }), { status: 503, headers: { 'Content-Type': 'application/json' } }));
    render(
      <MemoryRouter>
        <TemplateGarmentPicker design={getDesign('night-shift')!} />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('The shop is not available right now.');
  });
});
