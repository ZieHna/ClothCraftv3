// Real browser (Edge), real Fabric: the Design page's "Add this customization to cart" and "Proceed to checkout" (step 9). The upload is
// answered here; what it carries is checked: one scene (state, element list with opacity, an 800 px preview and a 3200 px print file), an
// Idempotency-Key, and the estimate kept with the cart line. The reasons the buttons are off are checked in words.
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import bounds from '../../../addons/clothcraft/data/garment_bounds.json';
import type { DesignPricing, DesignUpload } from '../api/types';
import { cartStore } from '../cart/cartStore';
import { estimate } from '../pricing/designFee';
import { EditorStage, type DesignCart, type PricingLoad } from './EditorStage';

const GARMENT = { image: '/garments/m-tee/white.webp', color: 'white', size: 'M', colorImages: { white: '/garments/m-tee/white.webp' } };
const BOX = bounds.products['m-tee'];
const PRICING: DesignPricing = {
  productId: 'm-tee', designable: true, message: null, box: { x: BOX.x, y: BOX.y, width: BOX.width, height: BOX.height }, referenceSqIn: 200, rate: 2, sizeStep: 20,
  steps: { XS: 0, S: 0, M: 1, L: 2, XL: 3, XXL: 4 }, band: 0.25, currency: 'PHP', vatIncluded: true,
  limits: { totalBytes: 20971520, pictureBytes: 5242880, pictures: 8, elements: 50, previewBytes: 2097152, printBytes: 12582912, stateBytes: 524288, printMaxPx: 4096, previewPx: 800 },
};

async function size(base64: string) {
  const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], { type: 'image/png' }));
  return [bitmap.width, bitmap.height];
}

describe('putting a design in the cart (real browser)', () => {
  let slot: HTMLDivElement;
  let uploads: { body: DesignUpload; key: string | null }[];
  let refuse: string | null;
  beforeEach(() => {
    localStorage.clear();
    cartStore.setOwner('1');
    slot = document.createElement('div');
    document.body.append(slot);
    uploads = [];
    refuse = null;
    const real = window.fetch.bind(window);
    vi.stubGlobal('fetch', async (url: RequestInfo, init: RequestInit = {}) => {
      if (typeof url === 'string' && url === '/api/designs' && init.method === 'POST') {
        uploads.push({ body: JSON.parse(String(init.body)), key: new Headers(init.headers).get('Idempotency-Key') });
        if (refuse) return new Response(JSON.stringify({ error: { code: 'picture_type', message: refuse } }), { status: 415, headers: { 'Content-Type': 'application/json' } });
        return new Response(JSON.stringify({ data: { id: String(11 + uploads.length), productId: 'm-tee', sku: 'M-TEE-WHT-M', state: 'draft', coveredSqIn: 1, layerCount: 1, printPx: 3200, createdAt: '', previewUrl: '', printUrl: '' }, simulation: null }), { status: 201, headers: { 'Content-Type': 'application/json' } });
      }
      return real(url, init);
    });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    slot.remove();
    cartStore.setOwner(null);
  });

  function mount(pricing: PricingLoad = { phase: 'ready', pricing: PRICING }, soldOut = false) {
    const onCheckout = vi.fn();
    const cart: DesignCart = { productId: 'm-tee', pricing, variantFor: () => ({ sku: 'M-TEE-WHT-M', price: 349, soldOut }), slot, onCheckout };
    render(<EditorStage mode="simple" garment={GARMENT} cart={cart} />);
    return { onCheckout };
  }
  const add = () => screen.getByRole('button', { name: 'Add this customization to cart' });
  const checkout = () => screen.getByRole('button', { name: 'Proceed to checkout' });
  const reason = () => screen.getByTestId('design-actions-reason').textContent;

  it('is off until there is something to print, and says why; then adds one scene with its estimate', async () => {
    mount();
    await waitFor(() => expect(reason()).toBe('Add something to your design first.'));
    expect(add()).toHaveAttribute('aria-disabled', 'true');
    expect(add()).toHaveAttribute('aria-describedby', 'cart-actions-reason-header');
    expect(screen.getByTestId('design-estimate').textContent?.trim()).toBe('Every element is priced by the rectangle around it.');

    act(() => screen.getByRole('button', { name: 'Add rectangle' }).click());
    await waitFor(() => expect(screen.queryByTestId('design-actions-reason')).toBeNull());
    expect(add()).toHaveAttribute('aria-disabled', 'false');
    expect(screen.getByTestId('design-estimate').textContent).toMatch(/^Estimated price ₱[\d,.]+ each \(print ₱[\d.]+, [\d.]+ sq in\)\. Every element is priced by the rectangle around it\.$/);

    act(() => add().click());
    await waitFor(() => expect(screen.getByTestId('design-cart-said')).toHaveTextContent('Added to your cart.'));
    expect(uploads).toHaveLength(1);
    const { body, key } = uploads[0]!;
    expect(key).toMatch(/\S{8,}/);
    expect([body.schemaVersion, body.productId, body.sku]).toEqual([1, 'm-tee', 'M-TEE-WHT-M']);
    const state = JSON.parse(body.state) as { schemaVersion: number; engine: string; state: { objects: { layerId: string; left: number; top: number }[] } };
    expect([state.schemaVersion, state.engine, state.state.objects.length]).toEqual([1, 'simple', 1]);
    expect(body.layers).toHaveLength(1);
    expect(body.layers[0]).toMatchObject({ id: state.state.objects[0]!.layerId, visible: true, opacity: 1 });
    expect(Math.abs(body.layers[0]!.x - state.state.objects[0]!.left)).toBeLessThan(0.5);
    expect(await size(body.preview)).toEqual([800, 800]);
    expect(await size(body.print)).toEqual([3200, 3200]);
    const expected = estimate(body.layers, PRICING.box!, 200, 2, 20, 'M').fee;
    expect(cartStore.get().lines).toEqual([{ sku: 'M-TEE-WHT-M', productId: 'm-tee', quantity: 1, designId: '12', estimate: expected }]);
  });

  it('step 10: Add to cart leaves the new line unticked; Proceed to checkout ticks only that design, on both paths', async () => {
    cartStore.add('W-POLO-BLK-S', 'w-polo', 1);
    cartStore.setSelected('W-POLO-BLK-S', true);
    const ticked = () => cartStore.get().lines.filter((l) => l.selected).map((l) => l.designId ?? l.sku);
    const { onCheckout } = mount();
    await waitFor(() => expect(reason()).toBe('Add something to your design first.'));
    act(() => screen.getByRole('button', { name: 'Add rectangle' }).click());
    await waitFor(() => expect(add()).toHaveAttribute('aria-disabled', 'false'));
    act(() => add().click());
    await waitFor(() => expect(uploads).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId('design-cart-said')).toBeTruthy());
    expect(ticked()).toEqual(['W-POLO-BLK-S']); // the new design is added unticked; the other line keeps its tick
    // right after adding: not sent again, and only this design is ticked
    act(() => checkout().click());
    await waitFor(() => expect(onCheckout).toHaveBeenCalledTimes(1));
    expect(ticked()).toEqual(['12']);
    expect(cartStore.justMade()).toBe('M-TEE-WHT-M#12');
    // after a change: sent again, and only the new design is ticked
    cartStore.setAllSelected(true);
    act(() => screen.getByRole('button', { name: 'Add text' }).click());
    await waitFor(() => expect(add()).toHaveAttribute('aria-disabled', 'false'));
    act(() => checkout().click());
    await waitFor(() => expect(onCheckout).toHaveBeenCalledTimes(2));
    expect(uploads).toHaveLength(2);
    expect(ticked()).toEqual(['13']);
    expect(cartStore.get().lines).toHaveLength(3);
  });

  it('Proceed to checkout right after adding does not send it again; after a change it does', async () => {
    const { onCheckout } = mount();
    await waitFor(() => expect(reason()).toBe('Add something to your design first.'));
    act(() => screen.getByRole('button', { name: 'Add rectangle' }).click());
    await waitFor(() => expect(add()).toHaveAttribute('aria-disabled', 'false'));
    act(() => add().click());
    await waitFor(() => expect(uploads).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId('design-cart-said')).toBeTruthy());
    act(() => checkout().click());
    await waitFor(() => expect(onCheckout).toHaveBeenCalledTimes(1));
    expect(uploads).toHaveLength(1);
    act(() => screen.getByRole('button', { name: 'Add text' }).click());
    await waitFor(() => expect(add()).toHaveAttribute('aria-disabled', 'false'));
    act(() => checkout().click());
    await waitFor(() => expect(onCheckout).toHaveBeenCalledTimes(2));
    expect(uploads).toHaveLength(2);
    expect(uploads[1]!.key).not.toBe(uploads[0]!.key);
    expect(cartStore.get().lines.map((l) => l.designId)).toEqual(['12', '13']);
  });

  it('a refusal shows the shop\'s sentence and changes nothing', async () => {
    mount();
    await waitFor(() => expect(reason()).toBe('Add something to your design first.'));
    act(() => screen.getByRole('button', { name: 'Add rectangle' }).click());
    await waitFor(() => expect(add()).toHaveAttribute('aria-disabled', 'false'));
    refuse = 'Only PNG, JPEG or WebP pictures can be used.';
    act(() => add().click());
    await waitFor(() => expect(screen.getByTestId('design-cart-said')).toHaveTextContent('Only PNG, JPEG or WebP pictures can be used.'));
    expect(screen.getByTestId('design-cart-said')).toHaveAttribute('role', 'alert');
    expect(cartStore.get().lines).toEqual([]);
    expect(screen.getByRole('button', { name: 'Add rectangle' })).toBeEnabled(); // the design is still open
  });

  it('says why in the mock shop, and states only the rule there', async () => {
    mount({ phase: 'mock' });
    await waitFor(() => expect(reason()).toBe('Ordering a design needs the real shop.'));
    expect(screen.getByTestId('design-estimate').textContent?.trim()).toBe('Every element is priced by the rectangle around it.');
  });

  it('a garment without a print box cannot be customized', async () => {
    mount({ phase: 'ready', pricing: { ...PRICING, designable: false, box: null, message: 'This garment cannot be customized yet.' } });
    await waitFor(() => expect(reason()).toBe('This garment cannot be customized yet.'));
  });

  it('Edit design: the saved design opens (straightened, with the note), and saving replaces the cart line and removes the old design', async () => {
    const deleted: string[] = [];
    const stubbed = window.fetch;
    vi.stubGlobal('fetch', async (url: RequestInfo, init: RequestInit = {}) => {
      if (init.method === 'DELETE') {
        deleted.push(String(url));
        return new Response(JSON.stringify({ data: { removed: true }, simulation: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return stubbed(url, init);
    });
    cartStore.add('M-TEE-WHT-M', 'm-tee', 3, { id: '7', estimate: 1 });
    const objects = [{ type: 'Rect', version: '7.4.0', layerId: 'L1', layerName: 'Rectangle', layerType: 'shape', shapeKind: 'rectangle', left: 400, top: 400, width: 120, height: 80, originX: 'center', originY: 'center', fill: '#c8203c', skewX: 15, skewY: 0, angle: 0, scaleX: 1, scaleY: 1, visible: true, opacity: 1 }];
    const initial = { schemaVersion: 1, engine: 'simple' as const, state: { fabric: '7.4.0', objects, counter: 1 }, assets: {} };
    const onCheckout = vi.fn();
    render(<EditorStage mode="simple" garment={GARMENT} cart={{ productId: 'm-tee', pricing: { phase: 'ready', pricing: PRICING }, variantFor: () => ({ sku: 'M-TEE-WHT-M', price: 349, soldOut: false }), slot, onCheckout, editing: { designId: '7', sku: 'M-TEE-WHT-M' }, initial }} />);
    await waitFor(() => expect(screen.getByTestId('design-straightened').textContent).toMatch(/^One slanted element was straightened/));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Update this customization in the cart' })).toHaveAttribute('aria-disabled', 'false'));
    act(() => screen.getByRole('button', { name: 'Update this customization in the cart' }).click());
    await waitFor(() => expect(screen.getByTestId('design-cart-said')).toHaveTextContent('Your cart now has this version of the design.'));
    const sent = JSON.parse(uploads[0]!.body.state) as { state: { objects: { skewX: number }[] } };
    expect(sent.state.objects[0]!.skewX).toBe(0);
    expect(cartStore.get().lines.map((l) => [l.designId, l.quantity])).toEqual([['12', 3]]);
    expect(deleted).toEqual(['/api/designs/7']);
  });

  it('a sold-out size is said so', async () => {
    mount(undefined, true);
    await waitFor(() => expect(reason()).toBe('Add something to your design first.'));
    act(() => screen.getByRole('button', { name: 'Add rectangle' }).click());
    await waitFor(() => expect(reason()).toBe('This size is sold out.'));
  });
});
