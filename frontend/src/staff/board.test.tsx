import { act, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffOrderSummary, TrackedState } from '../api/types';

// Step 11, the real shop only: the board. The API is answered here (a little in-memory shop), so every request can be seen.
vi.mock('../api/client', async (importOriginal) => ({ ...(await importOriginal<typeof import('../api/client')>()), API_MODE: 'odoo' as const }));

const { BoardPage } = await import('./BoardPage');

let wide = true;
let fine = true;
beforeAll(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  window.matchMedia = ((query: string) => ({
    matches: query.includes('min-width') ? wide : query.includes('pointer: fine') ? fine : false,
    media: query, addEventListener() {}, removeEventListener() {}, onchange: null, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  window.CSS ??= { escape: (s: string) => s } as unknown as typeof CSS;
});
afterAll(() => Reflect.deleteProperty(document, 'visibilityState'));

let orders: StaffOrderSummary[] = [];
let requests: { method: string; url: URL; body?: { to: string; expectedState: string } }[] = [];
let onMove: (id: string, body: { to: string; expectedState: string }) => Response;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(status < 400 ? { data, simulation: null } : data), { status, headers: { 'Content-Type': 'application/json' } });

function card(n: number, state: TrackedState, extra: Partial<StaffOrderSummary> = {}): StaffOrderSummary {
  return {
    id: String(n), reference: `S${String(n).padStart(5, '0')}`, state, paymentMethod: 'cod', paid: false, customer: { name: `Customer ${n}`, email: `c${n}@example.test` },
    total: 349, itemCount: 1, createdAt: '2026-10-20T01:00:00.000Z', statusChangedAt: new Date(Date.now() - 2 * 86400000).toISOString(), hasDesign: false, ...extra,
  };
}
function serve() {
  requests = [];
  vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, 'http://localhost');
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method: init.method ?? 'GET', url, body });
    const move = /\/api\/staff\/orders\/(\d+)\/transition$/.exec(url.pathname);
    if (move) return onMove(move[1]!, body);
    const state = url.searchParams.get('state');
    const page = Number(url.searchParams.get('page') ?? 1);
    const size = Number(url.searchParams.get('pageSize') ?? 25);
    const all = orders.filter((o) => o.state === state).sort((a, b) => Number(b.id) - Number(a.id));
    return json({ orders: all.slice((page - 1) * size, page * size), total: all.length, page, pageSize: size });
  });
  render(<RouterProvider router={createMemoryRouter([{ path: '/staff', element: <BoardPage /> }, { path: '/staff/orders/:id', element: <p>detail</p> }], { initialEntries: ['/staff'] })} />);
}
const column = (state: string) => screen.getAllByTestId('board-column').find((c) => c.dataset.state === state)!;
const cards = (state: string) => within(column(state)).queryAllByTestId('board-card').map((c) => c.dataset.order);
const gets = () => requests.filter((r) => r.method === 'GET').length;
const ok = (id: string, body: { to: string }) => {
  const o = orders.find((x) => x.id === id)!;
  o.state = body.to as TrackedState;
  return json({ id, state: body.to });
};

beforeEach(() => {
  wide = true;
  fine = true;
  orders = [
    card(1, 'awaiting_payment', { paymentMethod: 'bank_transfer' }), card(2, 'confirmed', { hasDesign: true }), card(3, 'confirmed'), card(4, 'shipped'),
    card(5, 'out_for_delivery'), card(6, 'delivered', { paid: true }),
    ...Array.from({ length: 30 }, (_v, i) => card(100 + i, 'closed')), card(200, 'cancelled'),
  ];
  onMove = ok;
});
afterEach(() => vi.unstubAllGlobals());

describe('the staff board (step 11)', () => {
  it('has the five step columns; closed and cancelled orders are never on it, only counted in the archive link', async () => {
    serve();
    await waitFor(() => expect(cards('confirmed')).toEqual(['3', '2']));
    expect(screen.getAllByTestId('board-column').map((c) => c.dataset.state)).toEqual(['awaiting_payment', 'confirmed', 'shipped', 'out_for_delivery', 'delivered']);
    expect(screen.getAllByTestId('board-card').map((c) => c.dataset.order).sort()).toEqual(['1', '2', '3', '4', '5', '6']);
    const asked = requests.map((r) => [r.url.searchParams.get('state'), r.url.searchParams.get('pageSize')]);
    expect(asked.filter(([s]) => s === 'closed' || s === 'cancelled')).toEqual([['closed', '1'], ['cancelled', '1']]);       // counts only, never cards
    await waitFor(() => expect(screen.getByTestId('board-archive')).toHaveTextContent('Archive: 30 closed, 1 cancelled'));
    expect(screen.getByTestId('board-archive')).toHaveAttribute('href', '/staff/orders?state=closed');
  });

  it('a card shows the reference (a link to the detail), customer, items, total, payment, design and age', async () => {
    serve();
    await waitFor(() => expect(cards('confirmed')).toContain('2'));
    const two = within(column('confirmed')).getAllByTestId('board-card').find((c) => c.dataset.order === '2')!;
    expect(within(two).getByRole('link', { name: 'S00002' })).toHaveAttribute('href', '/staff/orders/2');
    expect(two).toHaveTextContent('Customer 2');
    expect(two).toHaveTextContent('1 item · Cash on delivery');
    expect(two).toHaveTextContent('₱349');
    expect(two).toHaveTextContent('In this step for 2 days');
    expect(within(two).getByTestId('card-design')).toHaveTextContent('Customized');
    expect(within(column('delivered')).getByTestId('board-card')).toHaveTextContent('Waiting for the customer to confirm they received it.');
    expect(within(column('delivered')).queryByTestId('card-move')).toBeNull();
  });

  it('keyboard only: Tab to "Move to next step", Enter, the move carries the state the card showed, and focus goes to the next card', async () => {
    const user = userEvent.setup();
    serve();
    await waitFor(() => expect(cards('confirmed')).toEqual(['3', '2']));
    const button = within(column('confirmed')).getByRole('button', { name: 'Move S00003 to next step: Shipped' });
    expect(button).toHaveTextContent('Move to next step');
    button.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(cards('shipped')).toEqual(['4', '3']));
    expect(requests.filter((r) => r.method === 'POST').map((r) => [r.url.pathname, r.body])).toEqual([['/api/staff/orders/3/transition', { to: 'shipped', expectedState: 'confirmed' }]]);
    expect(cards('confirmed')).toEqual(['2']);
    await waitFor(() => expect(within(column('confirmed')).getByRole('button', { name: 'Move S00002 to next step: Shipped' })).toHaveFocus());
    expect(screen.getByTestId('board-said')).toHaveTextContent('S00003 moved to Shipped.');
    await user.keyboard(' ');                                          // Space works too, on the card that now has focus
    await waitFor(() => expect(cards('confirmed')).toEqual([]));
    await waitFor(() => expect(document.activeElement?.textContent).toMatch(/^Received & preparing/));       // the empty column's heading
  });

  it('a 409 conflict stays on the card in the shop\'s words, with what the order is now; nothing moves', async () => {
    const user = userEvent.setup();
    onMove = () => json({ error: { code: 'state_changed', message: 'This order is now shipped; it was changed by Sam Staff. Nothing was done. Check it and try again.', currentState: 'shipped' } }, 409);
    serve();
    await waitFor(() => expect(cards('confirmed')).toContain('3'));
    await user.click(within(column('confirmed')).getByRole('button', { name: 'Move S00003 to next step: Shipped' }));
    const problem = await within(column('confirmed')).findByTestId('card-problem');
    expect(problem).toHaveTextContent('This order is now shipped; it was changed by Sam Staff. Nothing was done. Check it and try again.');
    expect(problem).toHaveTextContent('Now: Shipped');
    expect(problem).toHaveAttribute('role', 'alert');
    expect(cards('confirmed')).toEqual(['3', '2']);
  });

  it('"Load more" adds the next page, and a refresh keeps every card it loaded (nothing collapses)', async () => {
    const user = userEvent.setup();
    orders.push(...Array.from({ length: 25 }, (_v, i) => card(300 + i, 'shipped')));
    serve();
    await waitFor(() => expect(cards('shipped')).toHaveLength(20));
    await user.click(within(column('shipped')).getByTestId('column-more'));
    await waitFor(() => expect(cards('shipped')).toHaveLength(26));
    expect(within(column('shipped')).queryByTestId('column-more')).toBeNull();
    const before = gets();
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(gets()).toBeGreaterThan(before));
    await waitFor(() => expect(requests.at(-1)).toBeTruthy());
    const refreshShipped = requests.slice(before).find((r) => r.url.searchParams.get('state') === 'shipped')!;
    expect(refreshShipped.url.searchParams.get('pageSize')).toBe('26');                     // as many as it shows
    expect(cards('shipped')).toHaveLength(26);
  });

  it('on a phone: one column at a time, chosen with tabs that the arrow keys move between', async () => {
    const user = userEvent.setup();
    wide = false;
    serve();
    const tabs = await screen.findAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Awaiting payment (1)', 'Received & preparing (2)', 'Shipped (1)', 'On delivery (1)', 'Delivered (1)'].map((s) => expect.stringContaining(s.split(' (')[0]!)));
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
    expect(screen.getAllByTestId('board-column').filter((c) => !c.hidden).map((c) => c.dataset.state)).toEqual(['confirmed']);
    tabs[1]!.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getAllByRole('tab')[2]).toHaveFocus();
    expect(screen.getAllByTestId('board-column').filter((c) => !c.hidden).map((c) => c.dataset.state)).toEqual(['shipped']);
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', screen.getAllByRole('tab')[2]!.id);
  });

  it('drag and drop (mouse): only the next column takes the card, the drop makes the same move, and no refresh runs during the drag', async () => {
    serve();
    await waitFor(() => expect(cards('confirmed')).toContain('3'));
    const three = within(column('confirmed')).getAllByTestId('board-card').find((c) => c.dataset.order === '3')!;
    expect(three).toHaveAttribute('draggable', 'true');
    const data = { effectAllowed: '', setData: vi.fn(), getData: () => '3' };
    fireEvent.dragStart(three, { dataTransfer: data });
    const wrong = createEvent.dragOver(column('out_for_delivery'), { dataTransfer: data });
    fireEvent(column('out_for_delivery'), wrong);
    expect(wrong.defaultPrevented).toBe(false);                   // not the next step: no drop
    const right = createEvent.dragOver(column('shipped'), { dataTransfer: data });
    fireEvent(column('shipped'), right);
    expect(right.defaultPrevented).toBe(true);
    expect(column('shipped')).toHaveTextContent('Drop here to move it on');
    const before = gets();
    await act(async () => {
      window.dispatchEvent(new Event('focus'));                    // a due refresh waits while a card is being dragged
    });
    expect(gets()).toBe(before);
    fireEvent.drop(column('shipped'), { dataTransfer: data });
    await waitFor(() => expect(cards('shipped')).toEqual(['4', '3']));
    expect(requests.filter((r) => r.method === 'POST').map((r) => r.body)).toEqual([{ to: 'shipped', expectedState: 'confirmed' }]);
  });

  it('a touch screen gets no dragging, only the button', async () => {
    fine = false;
    serve();
    await waitFor(() => expect(cards('confirmed')).toContain('3'));
    expect(within(column('confirmed')).getAllByTestId('board-card').every((c) => c.getAttribute('draggable') === 'false')).toBe(true);
    expect(within(column('confirmed')).getAllByRole('button', { name: /^Move S\d+ to next step/ })).toHaveLength(2);
  });
});
