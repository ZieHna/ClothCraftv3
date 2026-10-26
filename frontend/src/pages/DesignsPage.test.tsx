import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router';
import { describe, expect, it } from 'vitest';
import { DESIGN_CATALOG, designsInStyle, stylesInUse } from '../designs/catalog';
import { DesignsPage } from './DesignsPage';

function Where() {
  const { pathname, search } = useLocation();
  return <p data-testid="where">{pathname + search}</p>;
}
const renderAt = (url = '/designs') =>
  render(
    <RouterProvider
      router={createMemoryRouter(
        [
          {
            path: '/designs',
            element: (
              <>
                <DesignsPage />
                <Where />
              </>
            ),
          },
          { path: '/design', element: <Where /> },
        ],
        { initialEntries: [url] },
      )}
    />,
  );
const cards = () => screen.queryAllByTestId('design-card');
const where = () => screen.getByTestId('where').textContent;

describe('the Browse all designs page', () => {
  it('has the page heading and an introduction that says a design can be customized', () => {
    renderAt();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Find your next design.');
    expect(screen.getByText(/Pick a premade design you like/)).toBeInTheDocument();
    expect(screen.getByText(/where you can change the words, colours and shapes/)).toBeInTheDocument();
  });

  it('shows the carousel and one card per design of the catalog, from the same catalog the Featured section reads', () => {
    renderAt();
    expect(screen.getByTestId('design-carousel')).toBeInTheDocument();
    expect(cards()).toHaveLength(DESIGN_CATALOG.length);
    expect(screen.getByTestId('design-count')).toHaveTextContent(`Showing ${DESIGN_CATALOG.length} of ${DESIGN_CATALOG.length} designs.`);
  });

  it('every card shows a name, a style, what it is made for and Customize Design, and no price or stock', () => {
    renderAt();
    for (const card of cards()) {
      expect(within(card).getByRole('heading', { level: 3 }).textContent).toBeTruthy();
      expect(within(card).getByTestId('design-style').textContent).toBeTruthy();
      expect(card.textContent).toMatch(/Made for /);
      expect(card.textContent).not.toMatch(/₱|PHP|in stock|sold out|low stock/i);
      expect(within(card).getByRole('link', { name: /^Customize Design/ }).getAttribute('href')).toMatch(/^\/design\?template=[a-z0-9-]+$/);
    }
  });

  it('Customize Design opens the editor address with that design', async () => {
    const user = userEvent.setup({ delay: null });
    renderAt();
    const card = cards().find((c) => c.getAttribute('data-design') === 'kape-muna')!;
    await user.click(within(card).getByRole('link', { name: /Customize Design/ }));
    expect(where()).toBe('/design?template=kape-muna');
  });

  it('offers only the styles and apparel the catalog really has', () => {
    renderAt();
    const buttons = screen.getAllByRole('button').filter((b) => b.getAttribute('data-testid')?.startsWith('style-'));
    expect(buttons.map((b) => b.getAttribute('data-testid'))).toEqual(['style-all', ...stylesInUse().map((s) => `style-${s}`)]);
    const options = within(screen.getByTestId('apparel-filter')).getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
    expect(options[0]).toBe('all');
    expect(options).toContain('HOOD');
    expect(options).not.toContain('JKT'); // no design is made for jackets: no jacket filter
  });

  it('a style filter shows only that style, says how many, and goes into the address', async () => {
    const user = userEvent.setup({ delay: null });
    renderAt();
    await user.click(screen.getByTestId('style-Nature'));
    expect(cards()).toHaveLength(designsInStyle('Nature').length);
    expect(screen.getAllByTestId('design-style').every((s) => s.textContent === 'Nature')).toBe(true);
    expect(screen.getByTestId('design-count')).toHaveTextContent(`Showing ${designsInStyle('Nature').length} of ${DESIGN_CATALOG.length}`);
    expect(where()).toBe('/designs?style=Nature');
    expect(screen.getByTestId('style-Nature')).toHaveAttribute('aria-pressed', 'true');
  });

  it('style and apparel combine, an empty combination says so with a way out, and clearing shows everything', async () => {
    const user = userEvent.setup({ delay: null });
    renderAt();
    await user.click(screen.getByTestId('style-Streetwear'));
    await user.selectOptions(screen.getByTestId('apparel-filter'), 'ONESIE');
    expect(cards()).toHaveLength(0);
    expect(screen.getByTestId('designs-empty')).toHaveTextContent('No design matches');
    await user.click(screen.getByRole('button', { name: 'Show all designs' }));
    expect(cards()).toHaveLength(DESIGN_CATALOG.length);
    expect(where()).toBe('/designs');
  });

  it('reads the filters from the address, and ignores a style or apparel it does not know', () => {
    renderAt('/designs?style=Abstract&apparel=ONESIE');
    expect(cards().every((c) => /Abstract/.test(c.textContent ?? ''))).toBe(true);
    expect(cards().length).toBeGreaterThanOrEqual(1);
    const { unmount } = renderAt('/designs?style=Nonsense&apparel=XYZ');
    unmount();
    renderAt('/designs?style=Nonsense&apparel=XYZ');
    expect(screen.getAllByTestId('design-count').at(-1)).toHaveTextContent(`Showing ${DESIGN_CATALOG.length} of`);
  });
});
