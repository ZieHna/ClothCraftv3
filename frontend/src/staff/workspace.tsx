import { createContext, useContext, useLayoutEffect, useMemo, type ReactNode } from 'react';
import { API_MODE, setApiWorkspace } from '../api/client';
import type { StaffUser } from '../api/types';
import { useOptionalStaffAuth } from './StaffAuth';

/**
 * Where the reused staff pages (orders, stock, restocks, suppliers) are shown: the employee dashboard (/staff) or the admin dashboard (/admin).
 * The pages ask this for every link they draw and for the signed-in person, so the same page works in both. The provider also tells the API client
 * which workspace is active, so a page's /staff/... calls go to /api/admin/... under /admin (and carry the admin cookie, never the employee one).
 * The server decides who may do what; this only decides which address a link points to. Without a provider the employee defaults apply, which is how
 * the pages behave on their own.
 */
export type WorkspaceKind = 'staff' | 'admin';

export interface Workspace {
  kind: WorkspaceKind;
  user: StaffUser | null;
  /** the order board */
  board: string;
  /** the order list and archive */
  orders: string;
  order: (id: string) => string;
  stock: string;
  stockHistory: string;
  restocks: string;
  restockNew: string;
  restock: (id: string) => string;
  restockEdit: (id: string) => string;
  suppliers: string;
  supplierNew: string;
  supplier: (id: string) => string;
  supplierEdit: (id: string) => string;
}

function makeWorkspace(kind: WorkspaceKind, user: StaffUser | null): Workspace {
  const base = kind === 'admin' ? '/admin' : '/staff';
  return {
    kind,
    user,
    // /staff opens on the board (the frozen mock opens on the list); /admin has no board: /admin/orders is the counts summary, the list is /admin/orders/list
    board: kind === 'admin' ? '/admin/orders' : '/staff',
    orders: kind === 'admin' ? '/admin/orders/list' : API_MODE === 'mock' ? '/staff' : '/staff/orders',
    order: (id) => `${base}/orders/${id}`,
    stock: `${base}/stock`,
    stockHistory: `${base}/stock/history`,
    restocks: `${base}/restocks`,
    restockNew: `${base}/restocks/new`,
    restock: (id) => `${base}/restocks/${id}`,
    restockEdit: (id) => `${base}/restocks/${id}/edit`,
    suppliers: `${base}/suppliers`,
    supplierNew: `${base}/suppliers/new`,
    supplier: (id) => `${base}/suppliers/${id}`,
    supplierEdit: (id) => `${base}/suppliers/${id}/edit`,
  };
}

const WorkspaceContext = createContext<Workspace | null>(null);

export function WorkspaceProvider({ kind, user, children }: { kind: WorkspaceKind; user: StaffUser | null; children: ReactNode }) {
  const value = useMemo(() => makeWorkspace(kind, user), [kind, user]);
  // a layout effect runs before any child's effect, so the first call a page makes already goes to the right prefix; leaving puts it back
  useLayoutEffect(() => {
    setApiWorkspace(kind);
    return () => setApiWorkspace('staff');
  }, [kind]);
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): Workspace {
  const given = useContext(WorkspaceContext);
  const staff = useOptionalStaffAuth();
  const fallbackUser = staff?.user ?? null;
  return useMemo(() => given ?? makeWorkspace('staff', fallbackUser), [given, fallbackUser]);
}
