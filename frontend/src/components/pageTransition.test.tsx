import { act, fireEvent, render, screen } from '@testing-library/react';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cartStore } from '../cart/cartStore';
import { setDraftDbForTests } from '../drafts/db';
import { DraftSession } from '../drafts/DraftSession';
import { createMemoryDb } from '../drafts/memoryDb';
import { newEditor, polyfillDialog } from '../drafts/testSupport';
import { draftKey } from '../drafts/types';
import type { FakeEditor } from '../editor/fake/FakeEditor';
import { Layout } from './Layout';
import { RouteFallback, type RouteKind } from './skeleton/pageSkeletons';

/**
 * Step B: page changes. A new page fades in (no exit fade, so the new page is never held back), lazy pages show their own skeleton at once
 * instead of leaving the old page on screen, and keying <main> by the path must not cost anybody their work: what is typed, the cart, a design draft.
 */
beforeAll(() => {
  window.scrollTo = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
  polyfillDialog();
});
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  cartStore.setOwner(null);
});
afterEach(() => {
  setDraftDbForTests(undefined);
  vi.useRealTimers();
});

function Typed() {
  const [text, setText] = useState('');
  return <input aria-label="typed" value={text} onChange={(e) => setText(e.target.value)} />;
}

describe('the fade between pages', () => {
  const routes = (design: React.ReactNode = <p>design page</p>) => [
    {
      path: '/',
      element: <Layout />,
      children: [
        { path: 'checkout', element: <Typed /> },
        { path: 'category', element: <p>category page</p> },
        { path: 'design', element: design },
      ],
    },
  ];

  it('<main> carries the fade (it is keyed by the path, with the same layout classes as before) and the editor page keeps its window-sized classes', () => {
    const router = createMemoryRouter(routes(), { initialEntries: ['/category'] });
    render(<RouterProvider router={router} />);
    const main = screen.getByRole('main');
    expect(main).toHaveClass('page-fade', 'flex-1');
    act(() => void router.navigate('/design'));
    expect(screen.getByRole('main')).toHaveClass('page-fade', 'flex-1', 'lg:min-h-0');
  });

  it('a new path remounts <main> (so the fade plays); a query string or a #hash on the same path does not, and what is typed stays', () => {
    const router = createMemoryRouter(routes(), { initialEntries: ['/checkout'] });
    render(<RouterProvider router={router} />);
    const before = screen.getByRole('main');
    fireEvent.change(screen.getByLabelText('typed'), { target: { value: 'Juana' } });
    act(() => void router.navigate('/checkout?x=1'));
    act(() => void router.navigate('/checkout?x=1#section'));
    expect(screen.getByRole('main')).toBe(before);
    expect(screen.getByLabelText('typed')).toHaveValue('Juana');
    act(() => void router.navigate('/category'));
    expect(screen.getByRole('main')).not.toBe(before);
    expect(screen.getByText('category page')).toBeInTheDocument();
  });

  it('there is no fake wait: the new page is in the document in the same render as the navigation', () => {
    const router = createMemoryRouter(routes(), { initialEntries: ['/category'] });
    render(<RouterProvider router={router} />);
    act(() => void router.navigate('/design'));
    expect(screen.getByText('design page')).toBeInTheDocument();
    expect(screen.queryByText('category page')).not.toBeInTheDocument(); // the old page is gone at once (no exit animation)
  });
});

describe('lazy pages (React.lazy + Suspense)', () => {
  it.each<[RouteKind, string]>([
    ['cart', 'cart-loading'],
    ['checkout', 'cart-loading'],
    ['order', 'order-loading'],
    ['design', 'design-loading'],
    ['staff', 'staff-checking'],
  ])('the %s fallback is that page\'s own skeleton (aria-busy, with its Loading message)', async (kind, testId) => {
    render(<RouteFallback kind={kind} />);
    const region = await screen.findByTestId(testId); // the skeletons of the lazy pages are a small chunk of their own
    expect(region).toHaveAttribute('aria-busy', 'true');
    expect(region.querySelector('[role="status"]')).not.toBeNull();
  });

  it('navigating to a lazy page changes the URL and shows its skeleton at once; the old page does not stay on screen; then the page replaces the skeleton', async () => {
    let arrive: () => void = () => undefined;
    const Late = lazy(
      () =>
        new Promise<{ default: () => React.JSX.Element }>((resolve) => {
          arrive = () => resolve({ default: () => <h1>Your cart</h1> });
        }),
    );
    const router = createMemoryRouter(
      [
        {
          path: '/',
          element: <Layout />,
          children: [
            { path: 'category', element: <p>category page</p> },
            { path: 'cart', element: <Suspense fallback={<RouteFallback kind="cart" />}><Late /></Suspense> },
          ],
        },
      ],
      { initialEntries: ['/category'] },
    );
    render(<RouterProvider router={router} />);
    act(() => void router.navigate('/cart'));
    expect(router.state.location.pathname).toBe('/cart'); // the click did something at once
    expect(await screen.findByTestId('cart-loading')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText('category page')).not.toBeInTheDocument();
    await act(async () => arrive());
    expect(await screen.findByRole('heading', { name: 'Your cart' })).toBeInTheDocument();
    expect(screen.queryByTestId('cart-loading')).not.toBeInTheDocument();
  });
});

describe('what the keyed <main> must not lose', () => {
  it('the cart: its lines, quantities and ticks are the store\'s, so they are there after leaving the page and coming back', () => {
    cartStore.setOwner('1');
    cartStore.add('SKU-1', 'p1', 2);
    cartStore.add('SKU-2', 'p2', 1);
    cartStore.setSelected('SKU-2', true);
    const router = createMemoryRouter(
      [{ path: '/', element: <Layout />, children: [{ path: 'cart', element: <p>cart page</p> }, { path: 'category', element: <p>category page</p> }] }],
      { initialEntries: ['/cart'] },
    );
    render(<RouterProvider router={router} />);
    act(() => void router.navigate('/category'));
    act(() => void router.navigate('/cart'));
    expect(cartStore.get().lines.map((l) => [l.sku, l.quantity, !!l.selected])).toEqual([['SKU-1', 2, false], ['SKU-2', 1, true]]);
  });

  describe('a design draft on /design', () => {
    const KEY = draftKey('ana', 'p1', 'simple');
    let editor: FakeEditor | null = null;

    /** the editor page's contract with the draft: DraftSession saves while editing, and the editor writes the unsaved edits when it goes (EditorStage's clean-up) */
    function DesignStub() {
      const leaveRef = useRef<(() => Promise<void>) | null>(null);
      const [ready, setReady] = useState<FakeEditor | null>(null);
      useEffect(() => {
        void newEditor().then((e) => {
          editor = e;
          setReady(e);
        });
        return () => {
          void leaveRef.current?.();
        };
      }, []);
      if (!ready) return null;
      return (
        <DraftSession
          editor={ready}
          user="ana"
          productId="p1"
          engine="simple"
          describe={() => ({ sku: 'P1-WHT-M', productName: 'Crew Tee', colorName: 'White' })}
          options={{ productName: 'Crew Tee', colors: [{ id: 'white', name: 'White', hex: '#fff' }], sizes: ['M'], soldOut: () => false }}
          onDownload={() => undefined}
          announce={() => undefined}
          leaveRef={leaveRef}
        />
      );
    }
    const settle = (ms = 0) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

    it('an edit made just before navigating away is saved, and coming back offers it ("Continue your draft")', async () => {
      vi.useFakeTimers();
      const db = createMemoryDb();
      setDraftDbForTests(db);
      const router = createMemoryRouter(
        [{ path: '/', element: <Layout />, children: [{ path: 'design', element: <DesignStub /> }, { path: 'category', element: <p>category page</p> }] }],
        { initialEntries: ['/design'] },
      );
      render(<RouterProvider router={router} />);
      await settle(50);
      editor!.addText('Hello');
      expect(await db.get(KEY)).toBeUndefined(); // still inside the autosave delay: nothing stored yet
      act(() => void router.navigate('/category')); // the page goes: the new <main> replaces the old one
      await settle(50);
      expect((await db.get(KEY))?.layerCount).toBe(1); // the leave flushed it
      act(() => void router.navigate('/design'));
      await settle(50);
      expect(screen.getByRole('button', { name: 'Continue your draft' })).toBeInTheDocument();
      expect(document.body.textContent).toMatch(/1 layer/);
    });
  });
});
