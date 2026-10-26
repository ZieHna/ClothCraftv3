import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import type { StaffUser } from '../api/types';
import { CustomersIcon, DashboardIcon, EmployeesIcon, ForecastIcon, OrdersIcon, StocksIcon, SuppliersIcon } from './icons';

interface Item {
  label: string;
  to: string;
  icon: ReactNode;
  active: (pathname: string) => boolean;
}
const ITEMS: Item[] = [
  { label: 'Dashboard', to: '/admin', icon: <DashboardIcon />, active: (p) => p === '/admin' || p === '/admin/' },
  { label: 'Orders', to: '/admin/orders', icon: <OrdersIcon />, active: (p) => p.startsWith('/admin/orders') },
  { label: 'Stocks', to: '/admin/stock', icon: <StocksIcon />, active: (p) => p.startsWith('/admin/stock') || p.startsWith('/admin/restocks') },
  { label: 'Suppliers', to: '/admin/suppliers', icon: <SuppliersIcon />, active: (p) => p.startsWith('/admin/suppliers') },
  { label: 'Employees', to: '/admin/employees', icon: <EmployeesIcon />, active: (p) => p.startsWith('/admin/employees') },
  { label: 'Customers', to: '/admin/customers', icon: <CustomersIcon />, active: (p) => p.startsWith('/admin/customers') },
  { label: 'Forecast and DSS', to: '/admin/dss', icon: <ForecastIcon />, active: (p) => p.startsWith('/admin/dss') },
];

const row = 'flex min-h-11 w-full items-center gap-3 px-3 py-2 text-left text-base font-medium no-underline';

/** The role is written next to the name only when it adds something ("Administrator" as a name already says it). */
export const roleShown = (user: StaffUser): boolean => user.displayName.trim().toLowerCase() !== 'administrator';

/**
 * The admin navigation: the sections in order, the person and Sign out at the bottom. Used in the fixed sidebar (wide screens) and in the drawer
 * (narrow ones), so both always list the same things. `onNavigate` lets the drawer close when a link is followed.
 */
export function AdminNav({ user, onSignOut, onNavigate }: { user: StaffUser; onSignOut: () => void; onNavigate?: () => void }) {
  const { pathname } = useLocation();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <nav aria-label="Admin sections" className="min-h-0 flex-1 overflow-y-auto py-2">
        <ul>
          {ITEMS.map((item) => {
            const here = item.active(pathname);
            return (
              <li key={item.label}>
                <Link
                  to={item.to}
                  onClick={onNavigate}
                  aria-current={here ? 'page' : undefined}
                  className={`${row} ${here ? 'border-l-4 border-sage-dark bg-paper-warm pl-2 text-ink' : 'text-ink hover:bg-paper-warm'}`}
                  data-testid={`nav-${item.label.toLowerCase().replace(/\s+/g, '-')}`}
                >
                  {item.icon}
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="border-t border-tan p-3" data-testid="admin-who">
        <p className="truncate text-sm font-medium text-ink">{user.displayName}</p>
        {roleShown(user) && <p className="text-xs text-muted">Administrator</p>}
        <button type="button" onClick={onSignOut} className="btn btn-secondary btn-small mt-2 w-full" data-testid="admin-signout">
          Sign out
        </button>
      </div>
    </div>
  );
}
