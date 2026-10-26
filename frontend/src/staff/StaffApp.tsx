import { useEffect } from 'react';
import { API_MODE } from '../api/client';
import { Link, Outlet, useLocation } from 'react-router';
import { StaffCheckingSkeleton } from '../components/skeleton/routeSkeletons';
import { STAFF_MIN_SKELETON_MS } from '../lib/skeletonTiming';
import { useSkeletonGate } from '../lib/useSkeletonGate';
import { StaffBell } from './bell/StaffBell';
import { StaffAuthProvider, useStaffAuth } from './StaffAuth';
import { StaffSignIn } from './StaffSignIn';
import { ROLE_LABEL } from './staffText';

/**
 * The staff dashboard's frame (/staff). It is its own route tree, not part of the shop's Layout: no cart, no customer sign-in dialog, no
 * shop footer, and a customer session plays no part in it. Nothing inside shows until a staff member has signed in.
 */
export function StaffApp() {
  return (
    <StaffAuthProvider>
      <Shell />
    </StaffAuthProvider>
  );
}

/** Not for search engines, and the tab says where you are. Restored when the dashboard is left. */
function usePageIdentity() {
  useEffect(() => {
    const title = document.title;
    document.title = 'ClothCraft staff';
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    document.head.append(meta);
    return () => {
      document.title = title;
      meta.remove();
    };
  }, []);
}

/** Step 11 (real shop): the board is the first page; the list (search, filters and the archive of closed and cancelled orders) is the other view. */
function ViewSwitch({ pathname }: { pathname: string }) {
  const onBoard = pathname === '/staff' || pathname === '/staff/';
  const onList = pathname === '/staff/orders';
  const onStock = pathname === '/staff/stock' || pathname.startsWith('/staff/stock/');
  const onRestocks = pathname === '/staff/restocks' || pathname.startsWith('/staff/restocks/');
  const onSuppliers = pathname === '/staff/suppliers' || pathname.startsWith('/staff/suppliers/');
  const item = (active: boolean) => `inline-flex min-h-11 items-center border-b-2 px-3 text-sm font-medium ${active ? 'border-ink text-ink' : 'border-transparent text-muted hover:text-ink'}`;
  return (
    <nav aria-label="Staff views" className="border-b border-tan bg-paper" data-testid="staff-views">
      <div className="mx-auto flex max-w-7xl flex-wrap gap-x-2 px-4">
        <Link to="/staff" aria-current={onBoard ? 'page' : undefined} className={item(onBoard)}>
          Board
        </Link>
        <Link to="/staff/orders" aria-current={onList ? 'page' : undefined} className={item(onList)}>
          List and archive
        </Link>
        <Link to="/staff/stock" aria-current={onStock ? 'page' : undefined} className={item(onStock)}>
          Stock
        </Link>
        <Link to="/staff/restocks" aria-current={onRestocks ? 'page' : undefined} className={item(onRestocks)}>
          Restocks
        </Link>
        <Link to="/staff/suppliers" aria-current={onSuppliers ? 'page' : undefined} className={item(onSuppliers)}>
          Suppliers
        </Link>
      </div>
    </nav>
  );
}

function Shell() {
  usePageIdentity();
  const { user, status, notice, signOut } = useStaffAuth();
  const { pathname } = useLocation();
  const gate = useSkeletonGate(status === 'loading', { minMs: STAFF_MIN_SKELETON_MS });
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return (
    <div className="flex min-h-screen flex-col">
      <a href="#staff-main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:bg-cream focus:px-4 focus:py-2 focus:font-semibold focus:text-ink">
        Skip to main content
      </a>
      <header className="border-b border-tan bg-paper">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
          <Link to="/staff" className="flex items-center gap-2.5 no-underline" aria-label="ClothCraft staff, all orders">
            <img src="/site/logo-96.webp" alt="" width={40} height={40} className="size-9 rounded-sm" />
            <span className="font-display text-2xl font-bold italic leading-none text-ink sm:text-3xl">ClothCraft</span>
            <span className="rounded-sm border border-ink bg-ink px-2 py-0.5 text-xs font-semibold uppercase tracking-widest text-cream">Staff</span>
          </Link>
          {user && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1" data-testid="staff-who">
              <p className="text-sm">
                <span className="font-medium text-ink">{user.displayName}</span>
                <span className="text-muted"> · {user.workingAsEmployee ? 'Administrator (working as an employee)' : ROLE_LABEL[user.role]}</span>
              </p>
              {API_MODE !== 'mock' && <StaffBell />}
              <button type="button" onClick={signOut} className="btn btn-secondary btn-small">
                Sign out
              </button>
            </div>
          )}
        </div>
      </header>
      {user && API_MODE !== 'mock' && <ViewSwitch pathname={pathname} />}
      {user?.workingAsEmployee && (
        <p className="border-b border-tan bg-cream px-4 py-2 text-center text-sm text-muted" data-testid="staff-as-employee">
          The employee dashboard is for employee work only. Approvals, receiving, supplier status, opening balances, stock levels, employees and
          customers are in the admin dashboard:{' '}
          <Link to="/admin/login" className="underline underline-offset-4">
            Admin login
          </Link>
          .
        </p>
      )}
      {notice && (
        <p role="alert" className="border-b border-brown-dark bg-cream px-4 py-3 text-center font-medium text-brown-dark" data-testid="staff-session-ended">
          {notice}
        </p>
      )}
      <main key={pathname} id="staff-main" className="page-fade flex-1">
        {gate !== 'content' ? (
          <StaffCheckingSkeleton gate={gate} />
        ) : user ? (
          <Outlet />
        ) : (
          <StaffSignIn />
        )}
      </main>
      <footer className="border-t border-tan bg-paper px-4 py-4 text-center text-sm text-muted">
        <Link to="/" className="underline underline-offset-4">
          Back to the shop
        </Link>
      </footer>
    </div>
  );
}
