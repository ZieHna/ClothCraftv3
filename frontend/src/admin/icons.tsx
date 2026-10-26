import type { ReactNode } from 'react';

/** Small inline icons for the admin navigation (no icon package): 20 px, drawn with the current text colour, hidden from screen readers. */
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      {children}
    </svg>
  );
}

export const DashboardIcon = () => (
  <Icon>
    <rect x="3" y="3" width="7" height="9" />
    <rect x="14" y="3" width="7" height="5" />
    <rect x="14" y="12" width="7" height="9" />
    <rect x="3" y="16" width="7" height="5" />
  </Icon>
);
export const OrdersIcon = () => (
  <Icon>
    <path d="M6 3h12l2 4v14H4V7z" />
    <path d="M4 7h16" />
    <path d="M9 11a3 3 0 0 0 6 0" />
  </Icon>
);
export const StocksIcon = () => (
  <Icon>
    <path d="M3 8l9-5 9 5v8l-9 5-9-5z" />
    <path d="M3 8l9 5 9-5" />
    <path d="M12 13v8" />
  </Icon>
);
export const SuppliersIcon = () => (
  <Icon>
    <path d="M3 7h11v9H3z" />
    <path d="M14 10h4l3 3v3h-7" />
    <circle cx="7" cy="18" r="1.8" />
    <circle cx="17" cy="18" r="1.8" />
  </Icon>
);
export const EmployeesIcon = () => (
  <Icon>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
    <path d="M16 5.5a3 3 0 0 1 0 5.5" />
    <path d="M18 14.5c1.8.8 3 2.6 3 5.5" />
  </Icon>
);
export const CustomersIcon = () => (
  <Icon>
    <circle cx="12" cy="8" r="3.5" />
    <path d="M5 21c0-3.9 3.1-7 7-7s7 3.1 7 7" />
  </Icon>
);
export const ForecastIcon = () => (
  <Icon>
    <path d="M3 20h18" />
    <path d="M5 16l4-5 4 3 6-8" />
    <path d="M15 6h4v4" />
  </Icon>
);
export const MenuIcon = () => (
  <Icon>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Icon>
);
export const BellIcon = () => (
  <Icon>
    <path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6" />
    <path d="M10 19a2 2 0 0 0 4 0" />
  </Icon>
);
