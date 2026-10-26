import { useEffect, useState } from 'react';
import { Link, Navigate, Outlet, useLocation } from 'react-router';
import { StaffCheckingSkeleton } from '../components/skeleton/routeSkeletons';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { STAFF_MIN_SKELETON_MS } from '../lib/skeletonTiming';
import { useSkeletonGate } from '../lib/useSkeletonGate';
import { API_MODE } from '../api/client';
import { StaffBell } from '../staff/bell/StaffBell';
import { WorkspaceProvider } from '../staff/workspace';
import { AdminAuthProvider, useAdminAuth } from './AdminAuth';
import { AdminDrawer } from './AdminDrawer';
import { AdminNav } from './AdminNav';
import { AdminSignIn } from './AdminSignIn';
import { MenuIcon } from './icons';
import { SectionTabs } from './SectionTabs';

/**
 * The admin dashboard's frame (/admin). Its own route tree, like /staff: no shop cart, no customer sign-in, its own sign-in and its own session,
 * lazy and real build only. Signed in, it has a left side navigation (a fixed sidebar from 1024 px, a drawer below that) and one page per section;
 * the order, stock, restock and supplier pages are the employee dashboard's own pages, shown here with the admin session. Nothing inside shows
 * until an Administrator has signed in; who may enter and what they may do is decided by the server on every call.
 */
export function AdminApp() {
  return (
    <AdminAuthProvider>
      <Shell />
    </AdminAuthProvider>
  );
}

/** Not for search engines, and the tab says where you are. Restored when the dashboard is left. */
function usePageIdentity() {
  useEffect(() => {
    const title = document.title;
    document.title = 'ClothCraft admin';
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

function Brand() {
  return (
    <Link to="/admin" className="flex min-w-0 items-center gap-2 no-underline sm:gap-2.5" aria-label="ClothCraft admin, home">
      <img src="/site/logo-96.webp" alt="" width={40} height={40} className="size-9 shrink-0 rounded-sm" />
      <span className="font-display text-xl font-bold italic leading-none text-ink min-[26rem]:text-2xl sm:text-3xl">ClothCraft</span>
      <span className="hidden rounded-sm border border-ink bg-ink px-2 py-0.5 min-[26rem]:inline text-xs font-semibold uppercase tracking-widest text-cream">Admin</span>
    </Link>
  );
}

function Shell() {
  usePageIdentity();
  const { user, status, notice, signOut } = useAdminAuth();
  const { pathname } = useLocation();
  const wide = useMediaQuery('(min-width: 64rem)');
  const [drawer, setDrawer] = useState(false);
  const gate = useSkeletonGate(status === 'loading', { minMs: STAFF_MIN_SKELETON_MS });
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  // the drawer closes when a page is chosen, and when the window grows wide enough for the sidebar
  useEffect(() => {
    setDrawer(false);
  }, [pathname, wide]);
  const sidebar = Boolean(user) && wide;

  return (
    <WorkspaceProvider kind="admin" user={user}>
      <div className="min-h-screen">
        <a href="#admin-main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:bg-cream focus:px-4 focus:py-2 focus:font-semibold focus:text-ink">
          Skip to main content
        </a>
        {user && sidebar && (
          <aside className="fixed inset-y-0 left-0 z-30 flex w-64 flex-col border-r border-tan bg-paper" data-testid="admin-sidebar">
            <div className="border-b border-tan px-4 py-3">
              <Brand />
            </div>
            <div className="min-h-0 flex-1">
              <AdminNav user={user} onSignOut={signOut} />
            </div>
          </aside>
        )}
        <div className={`flex min-h-screen flex-col ${sidebar ? 'pl-64' : ''}`}>
          <header className="border-b border-tan bg-paper">
            <div className={`flex items-center gap-2 px-4 py-3 sm:gap-3 ${sidebar ? 'justify-end' : 'justify-between'}`}>
              {user && !sidebar && (
                <button
                  type="button"
                  onClick={() => setDrawer(true)}
                  aria-expanded={drawer}
                  aria-haspopup="dialog"
                  aria-label="Open the admin menu"
                  className="btn btn-secondary btn-small"
                  data-testid="admin-menu-button"
                >
                  <MenuIcon />
                </button>
              )}
              {!sidebar && <Brand />}
              {user && (
                <>
                  {!sidebar && <span className="flex-1" />}
                  {API_MODE !== 'mock' && <StaffBell />}
                </>
              )}
            </div>
          </header>
          {notice && (
            <p role="alert" className="border-b border-brown-dark bg-cream px-4 py-3 text-center font-medium text-brown-dark" data-testid="admin-session-ended">
              {notice}
            </p>
          )}
          {user && <SectionTabs />}
          <main key={pathname} id="admin-main" className="page-fade flex-1">
            {gate !== 'content' ? <StaffCheckingSkeleton gate={gate} /> : user ? <Outlet /> : <AdminSignIn />}
          </main>
          <footer className="border-t border-tan bg-paper px-4 py-4 text-center text-sm text-muted">
            <Link to="/" className="underline underline-offset-4">
              Back to the shop
            </Link>
          </footer>
        </div>
        {user && !sidebar && drawer && (
          <AdminDrawer onClose={() => setDrawer(false)}>
            <AdminNav user={user} onSignOut={signOut} onNavigate={() => setDrawer(false)} />
          </AdminDrawer>
        )}
      </div>
    </WorkspaceProvider>
  );
}

/** /admin/login: the sign-in form is what the shell shows to someone who is not signed in; once signed in, this goes on to the dashboard. */
export function AdminLoginRoute() {
  return <Navigate to="/admin" replace />;
}
