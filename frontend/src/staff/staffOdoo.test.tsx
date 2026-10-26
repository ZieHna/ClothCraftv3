import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

// This whole file runs as if built with VITE_API=odoo: API_MODE is "odoo" for every module that imports it, and the build-time constant
// that decides whether the demo accounts exist is "odoo" as well.
vi.stubEnv('VITE_API', 'odoo');
vi.mock('../api/client', async (importOriginal) => ({ ...(await importOriginal<typeof import('../api/client')>()), API_MODE: 'odoo' as const }));

const { StaffApp } = await import('./StaffApp');

describe('the staff dashboard in an Odoo build', () => {
  it('shows the sign-in form with no demo accounts, no demo wording and no demo address or password anywhere in the page', async () => {
    const router = createMemoryRouter([{ path: '/staff', element: <StaffApp />, children: [{ index: true, element: <p>Orders</p> }] }], { initialEntries: ['/staff'] });
    const { container } = render(<RouterProvider router={router} />);
    expect(await screen.findByRole('heading', { name: 'Staff sign in' })).toBeInTheDocument();
    // give a lazy chunk the time it would need, then look at everything that is on screen
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(screen.queryByTestId('staff-demo-hint')).not.toBeInTheDocument();
    const page = container.innerHTML + document.head.innerHTML;
    expect(page).not.toMatch(/demo/i);
    expect(page).not.toContain('inventory.demo@clothcraft.test');
    expect(page).not.toContain('admin.demo@clothcraft.test');
    expect(page).not.toContain('demo administrator');
    expect(page).not.toContain('demo inventory staff');
    expect(screen.getByLabelText('Email')).toHaveValue('');
  });
});
