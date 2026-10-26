import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BrowseDesigns } from './BrowseDesigns';
import { Hero } from './Hero';

const auth = vi.hoisted(() => ({ signedIn: false, asked: vi.fn() }));
vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({
    user: auth.signedIn ? { id: '1', displayName: 'Ana', email: 'ana@example.test' } : null,
    status: 'ready',
    // what the real one does: signed in, run it now; signed out, ask for sign-in first (and run it only after the customer signs in)
    requireAccount: (then: () => void, why?: string) => {
      if (auth.signedIn) then();
      else auth.asked(why);
    },
  }),
}));

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  auth.signedIn = false;
  auth.asked.mockClear();
});

function Where() {
  const { pathname, hash } = useLocation();
  return <p data-testid="where">{pathname + hash}</p>;
}
const renderPage = (element: React.ReactNode) =>
  render(
    <RouterProvider
      router={createMemoryRouter([
        { path: '/', element: <>{element}<Where /></> },
        { path: '/category', element: <><h1>Category page</h1><Where /></> },
      ])}
    />,
  );

describe('the old Browse designs placeholder section (no longer on the landing page: the designs have their own page, /designs)', () => {
  it('has a stable id, its own heading and one honest line', () => {
    const { container } = renderPage(<BrowseDesigns />);
    const section = container.querySelector('#browse-designs');
    expect(section).not.toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: /^Browse designs\.?$/ })).toBeInTheDocument();
    expect(section).toHaveAttribute('aria-labelledby', 'browse-designs-title');
    expect(screen.getByTestId('browse-designs-note')).toHaveTextContent('Predesigned shirts are coming soon.');
    expect(section?.querySelectorAll('a, button')).toHaveLength(0); // nothing to click yet, nothing invented
  });
});

describe('the hero buttons', () => {
  it('"Browse designs" is a link to the Browse all designs page (/designs)', () => {
    renderPage(<Hero />);
    const link = screen.getByRole('link', { name: 'Browse designs' });
    expect(link).toHaveAttribute('href', '/designs');
  });

  it('"Design your own" asks a signed-out visitor to sign in first, and goes nowhere until they do', async () => {
    const user = userEvent.setup({ delay: null });
    renderPage(<Hero />);
    await user.click(screen.getByRole('button', { name: 'Design your own' }));
    expect(auth.asked).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('where')).toHaveTextContent('/');
    expect(screen.getByTestId('where').textContent).toBe('/');
  });

  it('"Design your own" takes a signed-in customer to the Category page', async () => {
    const user = userEvent.setup({ delay: null });
    auth.signedIn = true;
    renderPage(<Hero />);
    await user.click(screen.getByRole('button', { name: 'Design your own' }));
    expect(await screen.findByRole('heading', { name: 'Category page' })).toBeInTheDocument();
    expect(screen.getByTestId('where').textContent).toBe('/category');
  });
});
