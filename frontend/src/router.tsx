import { lazy, Suspense } from 'react';
import { createBrowserRouter } from 'react-router';
import { API_MODE } from './api/client';
import { Layout } from './components/Layout';
import { RouteFallback, type RouteKind } from './components/skeleton/pageSkeletons';
import { Account } from './pages/Account';
import { BrowseRedirect } from './pages/BrowseRedirect';
import { Category } from './pages/Category';
import { Landing } from './pages/Landing';
import { NotFound } from './pages/NotFound';
import { Product } from './pages/Product';

/**
 * Shown only until the first page is ready: a direct visit to a lazy route (cart, checkout, orders, design) has to fetch
 * that page's chunk before anything can render. Without a fallback React Router logs "No `HydrateFallback` element provided"
 * on those visits (it depends on whether the chunk arrives before the first paint).
 */
function HydrateFallback() {
  return (
    <p role="status" className="p-6 text-center text-muted">
      Loading…
    </p>
  );
}

/**
 * Step B: the pages that are loaded on demand (the designer and Fabric behind it, the shopping pages, the staff dashboard). They are
 * React.lazy components inside a Suspense, not router `lazy` routes: with a router `lazy` the old page stays on screen, with nothing to say
 * the click did anything, until the new chunk has arrived. Here the URL changes at once and the page's own skeleton stands in (drawn after the
 * usual delay, and never held back: the chunk is not made to wait). Each chunk is still its own file, so none of it is in the entry bundle.
 */
const DesignsPage = lazy(async () => ({ default: (await import('./pages/DesignsPage')).DesignsPage }));
const Design = lazy(async () => ({ default: (await import('./pages/Design')).Design }));
const Cart = lazy(async () => ({ default: (await import('./pages/Cart')).Cart }));
const Checkout = lazy(async () => ({ default: (await import('./pages/Checkout')).Checkout }));
const OrderPage = lazy(async () => ({ default: (await import('./pages/OrderPage')).OrderPage }));
const StaffApp = lazy(async () => ({ default: (await import('./staff/StaffApp')).StaffApp }));
const StaffBoard = lazy(async () => ({ default: (await import('./staff/BoardPage')).BoardPage }));
const StaffOrders = lazy(async () => ({ default: (await import('./staff/OrdersPage')).OrdersPage }));
const StaffOrder = lazy(async () => ({ default: (await import('./staff/OrderDetailPage')).OrderDetailPage }));
const StaffSuppliers = lazy(async () => ({ default: (await import('./staff/suppliers/SuppliersPage')).SuppliersPage }));
const StaffSupplier = lazy(async () => ({ default: (await import('./staff/suppliers/SupplierDetailPage')).SupplierDetailPage }));
const StaffSupplierForm = lazy(async () => ({ default: (await import('./staff/suppliers/SupplierFormPage')).SupplierFormPage }));
const StaffStock = lazy(async () => ({ default: (await import('./staff/stock/StockPage')).StockPage }));
const StaffStockHistory = lazy(async () => ({ default: (await import('./staff/stock/StockHistoryPage')).StockHistoryPage }));
const StaffRestocks = lazy(async () => ({ default: (await import('./staff/restocks/RestocksPage')).RestocksPage }));
const StaffRestock = lazy(async () => ({ default: (await import('./staff/restocks/RestockDetailPage')).RestockDetailPage }));
const StaffRestockForm = lazy(async () => ({ default: (await import('./staff/restocks/RestockFormPage')).RestockFormPage }));
const AdminApp = lazy(async () => ({ default: (await import('./admin/AdminApp')).AdminApp }));
const AdminLogin = lazy(async () => ({ default: (await import('./admin/AdminApp')).AdminLoginRoute }));
const AdminOrdersSummary = lazy(async () => ({ default: (await import('./admin/orders/OrdersSummaryPage')).OrdersSummaryPage }));
const AdminHomePage = lazy(async () => ({ default: (await import('./admin/dashboard/DashboardPage')).DashboardPage }));
const AdminEmployees = lazy(async () => ({ default: (await import('./admin/employees/EmployeesPage')).EmployeesPage }));
const AdminEmployee = lazy(async () => ({ default: (await import('./admin/employees/EmployeeDetailPage')).EmployeeDetailPage }));
const AdminEmployeeForm = lazy(async () => ({ default: (await import('./admin/employees/EmployeeFormPage')).EmployeeFormPage }));
const AdminCustomers = lazy(async () => ({ default: (await import('./admin/customers/CustomersPage')).CustomersPage }));
const AdminCustomer = lazy(async () => ({ default: (await import('./admin/customers/CustomerDetailPage')).CustomerDetailPage }));
const AdminCustomerForm = lazy(async () => ({ default: (await import('./admin/customers/CustomerFormPage')).CustomerFormPage }));
const AdminDssOverview = lazy(async () => ({ default: (await import('./admin/dss/OverviewPage')).OverviewPage }));
const AdminDssForecast = lazy(async () => ({ default: (await import('./admin/dss/ForecastPage')).ForecastPage }));
const AdminNotFoundPage = lazy(async () => ({ default: (await import('./admin/AdminHome')).AdminNotFound }));
const StaffNotFound = lazy(async () => ({ default: (await import('./staff/StaffNotFound')).StaffNotFound }));

const later = (kind: RouteKind, page: React.ReactNode) => <Suspense fallback={<RouteFallback kind={kind} />}>{page}</Suspense>;

export const router = createBrowserRouter([
  {
    path: '/',
    element: <Layout />,
    HydrateFallback,
    children: [
      { index: true, element: <Landing /> },
      { path: 'category', element: <Category /> },
      // the page was called Browse until step A: old links, bookmarks and tests keep working, with their query string and #hash
      { path: 'browse', element: <BrowseRedirect /> },
      { path: 'designs', element: <Suspense fallback={<p role="status" className="p-6 text-center text-muted">Loading…</p>}><DesignsPage /></Suspense> },
      { path: 'products/:id', element: <Product /> },
      // lazy: the designer (and, behind it, Fabric) is never part of the landing or browse bundle
      { path: 'design', element: later('design', <Design />) },
      // lazy as well: the shopping pages are not part of the landing or browse bundle
      { path: 'cart', element: later('cart', <Cart />) },
      { path: 'checkout', element: later('checkout', <Checkout />) },
      { path: 'orders/:id', element: later('order', <OrderPage />) },
      { path: 'account', element: <Account /> },
      { path: '*', element: <NotFound /> },
    ],
  },
  // The staff dashboard is a route tree of its own, outside the shop Layout (no cart, no customer sign-in, no shop footer), and lazy: a
  // shopper never downloads it. It has the same HydrateFallback for a direct visit.
  {
    path: '/staff',
    HydrateFallback,
    element: later('staff', <StaffApp />),
    children: [
      // step 11: the real shop opens on the board, with the list (search, filters, the archive) at /staff/orders; the frozen mock keeps
      // the list as its first page
      API_MODE === 'mock' ? { index: true, element: later('staff', <StaffOrders />) } : { index: true, element: later('staff', <StaffBoard />) },
      { path: 'orders', element: later('staff', <StaffOrders />) },
      { path: 'orders/:id', element: later('staff', <StaffOrder />) },
      // phases 5 and 6: suppliers, stock, restocks (the real shop only: the frozen mock has none of these endpoints, so there these addresses are "not found")
      ...(API_MODE === 'mock'
        ? []
        : [
            { path: 'stock', element: later('staff', <StaffStock />) },
            { path: 'stock/history', element: later('staff', <StaffStockHistory />) },
            { path: 'restocks', element: later('staff', <StaffRestocks />) },
            { path: 'restocks/new', element: later('staff', <StaffRestockForm />) },
            { path: 'restocks/:id', element: later('staff', <StaffRestock />) },
            { path: 'restocks/:id/edit', element: later('staff', <StaffRestockForm />) },
            { path: 'suppliers', element: later('staff', <StaffSuppliers />) },
            { path: 'suppliers/new', element: later('staff', <StaffSupplierForm />) },
            { path: 'suppliers/:id', element: later('staff', <StaffSupplier />) },
            { path: 'suppliers/:id/edit', element: later('staff', <StaffSupplierForm />) },
          ]),
      { path: '*', element: later('staff', <StaffNotFound />) },
    ],
  },
  // step 7a: the Administrator's own area, a route tree of its own like /staff (real shop only: the frozen mock has no admin sign-in)
  ...(API_MODE === 'mock'
    ? []
    : [
        {
          path: '/admin',
          HydrateFallback,
          element: later('staff', <AdminApp />),
          children: [
            { index: true, element: later('staff', <AdminHomePage />) },
            { path: 'login', element: later('staff', <AdminLogin />) },
            // step 7e-1: the employee dashboard's own pages, shown under /admin (they take their links and their API prefix from the workspace)
            { path: 'orders', element: later('staff', <AdminOrdersSummary />) }, // counts only; the kanban board stays on /staff
            { path: 'orders/list', element: later('staff', <StaffOrders />) },
            { path: 'orders/:id', element: later('staff', <StaffOrder />) },
            { path: 'stock', element: later('staff', <StaffStock />) },
            { path: 'stock/history', element: later('staff', <StaffStockHistory />) },
            { path: 'restocks', element: later('staff', <StaffRestocks />) },
            { path: 'restocks/new', element: later('staff', <StaffRestockForm />) },
            { path: 'restocks/:id', element: later('staff', <StaffRestock />) },
            { path: 'restocks/:id/edit', element: later('staff', <StaffRestockForm />) },
            { path: 'suppliers', element: later('staff', <StaffSuppliers />) },
            { path: 'suppliers/new', element: later('staff', <StaffSupplierForm />) },
            { path: 'suppliers/:id', element: later('staff', <StaffSupplier />) },
            { path: 'suppliers/:id/edit', element: later('staff', <StaffSupplierForm />) },
            // step 7c: employee management, the Administrator's own (no twin under /staff)
            { path: 'employees', element: later('staff', <AdminEmployees />) },
            { path: 'employees/new', element: later('staff', <AdminEmployeeForm />) },
            { path: 'employees/:id', element: later('staff', <AdminEmployee />) },
            { path: 'employees/:id/edit', element: later('staff', <AdminEmployeeForm />) },
            // step 7d: customer management, the Administrator's own (no twin under /staff); there is no "add a customer": they register in the shop
            { path: 'customers', element: later('staff', <AdminCustomers />) },
            { path: 'customers/:id', element: later('staff', <AdminCustomer />) },
            { path: 'customers/:id/edit', element: later('staff', <AdminCustomerForm />) },
            // B8 S5a: Forecast and DSS (read-only decision support; the Overview first, the other tabs follow)
            { path: 'dss', element: later('staff', <AdminDssOverview />) },
            { path: 'dss/forecast', element: later('staff', <AdminDssForecast />) },
            { path: '*', element: later('staff', <AdminNotFoundPage />) },
          ],
        },
      ]),
]);
