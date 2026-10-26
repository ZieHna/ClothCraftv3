import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDraftDbForTests } from '../drafts/db';
import { rowFor, blob } from '../drafts/dbContract';
import { createMemoryDb } from '../drafts/memoryDb';
import { DraftsList } from './DraftsList';

vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ user: { id: '7', displayName: 'ana', email: 'ana@example.test' } }) }));

const view = () =>
  render(
    <MemoryRouter>
      <DraftsList />
    </MemoryRouter>,
  );

describe('DraftsList (Account: Your drafts)', () => {
  let db: ReturnType<typeof createMemoryDb>;
  beforeEach(() => {
    db = createMemoryDb();
    setDraftDbForTests(db);
  });
  afterEach(() => setDraftDbForTests(undefined));

  it('says so when there are no drafts', async () => {
    view();
    expect(await screen.findByTestId('drafts-empty')).toBeInTheDocument();
  });

  it('lists this person\'s drafts with garment, layers, size and an Open link into the designer, and the total', async () => {
    await db.commit({ row: rowFor('u7', 'p1', ['a'], { bytes: 2 * 1024 * 1024, layerCount: 3, sku: 'P1-NVY-M' }), expectedRevision: 0, putAssets: { a: blob('x') } });
    await db.commit({ row: rowFor('ben', 'p1'), expectedRevision: 0, putAssets: {} });
    view();
    const rows = await screen.findAllByTestId('draft-row');
    expect(rows).toHaveLength(1); // ben's is not shown
    expect(rows[0]).toHaveTextContent('Crew Tee');
    expect(rows[0]).toHaveTextContent('Navy, size M · 3 layers · 2.0 MB');
    expect(within(rows[0]!).getByRole('link', { name: 'Open the Crew Tee draft' })).toHaveAttribute('href', '/design?product=p1&variant=P1-NVY-M');
    expect(screen.getByTestId('drafts-total')).toHaveTextContent('Using 2.0 MB of 30.0 MB');
  });

  it('Delete asks first; keeping it changes nothing, confirming removes the draft and its pictures', async () => {
    const row = rowFor('u7', 'p1', ['a']);
    await db.commit({ row, expectedRevision: 0, putAssets: { a: blob('x') } });
    view();
    const del = await screen.findByRole('button', { name: 'Delete the Crew Tee draft' });
    fireEvent.click(del);
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(await db.get(row.key)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Delete the Crew Tee draft' }));
    expect(screen.getByText('Delete this draft for good?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, delete' }));
    await waitFor(() => expect(screen.getByTestId('drafts-empty')).toBeInTheDocument());
    expect(await db.get(row.key)).toBeUndefined();
    expect(await db.assetKeys()).toEqual([]);
  });

  it('says drafts are unavailable when the browser has no storage for them', async () => {
    setDraftDbForTests(null);
    view();
    expect(await screen.findByTestId('drafts-list-unavailable')).toBeInTheDocument();
  });
});
