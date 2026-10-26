import { Link, useLocation } from 'react-router';

interface Tab {
  label: string;
  to: string;
  active: (pathname: string) => boolean;
}

/** The tabs inside a section: Orders has the board and the list; Stocks has the stock and the restocks. Other sections have none. */
function tabsFor(pathname: string): { label: string; tabs: Tab[] } | null {
  if (pathname.startsWith('/admin/orders')) {
    return {
      label: 'Orders views',
      tabs: [
        { label: 'Summary', to: '/admin/orders', active: (p) => p === '/admin/orders' || p === '/admin/orders/' },
        { label: 'List and archive', to: '/admin/orders/list', active: (p) => p === '/admin/orders/list' },
      ],
    };
  }
  if (pathname.startsWith('/admin/stock') || pathname.startsWith('/admin/restocks')) {
    return {
      label: 'Stocks views',
      tabs: [
        { label: 'Stock', to: '/admin/stock', active: (p) => p.startsWith('/admin/stock') },
        { label: 'Restocks', to: '/admin/restocks', active: (p) => p.startsWith('/admin/restocks') },
      ],
    };
  }
  if (pathname.startsWith('/admin/dss')) {
    // Overview and Forecast so far: Restock, Segments, Health and About are added by their own steps (each is a link to its own address)
    return {
      label: 'Forecast and DSS views',
      tabs: [
        { label: 'Overview', to: '/admin/dss', active: (p) => p === '/admin/dss' || p === '/admin/dss/' },
        { label: 'Forecast', to: '/admin/dss/forecast', active: (p) => p.startsWith('/admin/dss/forecast') },
      ],
    };
  }
  return null;
}

export function SectionTabs() {
  const { pathname } = useLocation();
  const set = tabsFor(pathname);
  if (!set) return null;
  const item = (active: boolean) => `inline-flex min-h-11 items-center border-b-2 px-3 text-sm font-medium ${active ? 'border-ink text-ink' : 'border-transparent text-muted hover:text-ink'}`;
  return (
    <nav aria-label={set.label} className="border-b border-tan bg-paper" data-testid="section-tabs">
      <div className="flex flex-wrap gap-x-2 px-4">
        {set.tabs.map((t) => {
          const here = t.active(pathname);
          return (
            <Link key={t.to} to={t.to} aria-current={here ? 'page' : undefined} className={item(here)}>
              {t.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
