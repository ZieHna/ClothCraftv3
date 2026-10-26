import { apiGet, apiSend } from './client';

/**
 * The Administrator's employee management (step 7c), under /api/admin only (these routes do not exist under /api/staff). An employee is a person
 * who signs in to the staff or admin dashboard (Inventory Staff or Administrator); Odoo's own base admin, the API service and customers are never
 * listed. Every rule (yourself, the last Administrator, a unique email, the password) is decided by Odoo; a refusal is a 409 `refused` with a
 * sentence, a field problem is a 422 with `fields`. A password is sent once and is never in any reply.
 *   GET   /admin/employees?q&status&page&pageSize   -> {total, page, pageSize, employees}
 *   GET   /admin/employees/:id                      -> {employee, audit}     (404 for anyone who is not an employee)
 *   POST  /admin/employees (201)                    {name, email, role, password, jobTitle?, phone?} -> {employee}
 *   PATCH /admin/employees/:id                      {name?, email?, jobTitle?, phone?} -> {employee}
 *   PUT   /admin/employees/:id/role                 {role} -> {employee}
 *   POST  /admin/employees/:id/reset-password       {password} -> {employee}
 *   POST  /admin/employees/:id/deactivate | /reactivate -> {employee}
 */
export type EmployeeRole = 'inventory' | 'admin';
export const ROLE_LABEL: Record<EmployeeRole, string> = { inventory: 'Inventory Staff', admin: 'Administrator' };

export interface Employee {
  id: string;
  name: string;
  email: string;
  role: EmployeeRole;
  active: boolean;
  /** null: has not signed in yet */
  lastSignInAt: string | null;
  jobTitle: string | null;
  phone: string | null;
  /** two-step verification is on, which the dashboards do not support: this person cannot sign in */
  twoStep: boolean;
  /** this is the signed-in Administrator */
  isSelf: boolean;
}
export type AuditValues = Partial<{ name: string; email: string; jobTitle: string | null; phone: string | null; role: EmployeeRole; active: boolean }>;
export interface EmployeeAuditEntry {
  id: string;
  at: string;
  action: 'created' | 'edited' | 'role_changed' | 'password_reset' | 'deactivated' | 'reactivated';
  actorName: string;
  old: AuditValues | null;
  new: AuditValues | null;
}
export interface EmployeeList {
  total: number;
  page: number;
  pageSize: number;
  employees: Employee[];
}
export interface EmployeeBody {
  name?: string;
  email?: string;
  jobTitle?: string;
  phone?: string;
}

const enc = encodeURIComponent;
const n = (value: number | undefined) => (value ? String(value) : undefined);

export const listEmployees = (query: { q?: string; status?: string; page?: number; pageSize?: number }, signal?: AbortSignal) =>
  apiGet<EmployeeList>('/admin/employees', { q: query.q, status: query.status, page: n(query.page), pageSize: n(query.pageSize) }, signal);
export const getEmployee = (id: string, signal?: AbortSignal) => apiGet<{ employee: Employee; audit: EmployeeAuditEntry[] }>(`/admin/employees/${enc(id)}`, {}, signal);
export const createEmployee = (body: EmployeeBody & { name: string; email: string; role: EmployeeRole; password: string }) =>
  apiSend<{ employee: Employee }>('POST', '/admin/employees', body);
export const updateEmployee = (id: string, body: EmployeeBody) => apiSend<{ employee: Employee }>('PATCH', `/admin/employees/${enc(id)}`, body);
export const setEmployeeRole = (id: string, role: EmployeeRole) => apiSend<{ employee: Employee }>('PUT', `/admin/employees/${enc(id)}/role`, { role });
export const resetEmployeePassword = (id: string, password: string) => apiSend<{ employee: Employee }>('POST', `/admin/employees/${enc(id)}/reset-password`, { password });
export const deactivateEmployee = (id: string) => apiSend<{ employee: Employee }>('POST', `/admin/employees/${enc(id)}/deactivate`);
export const reactivateEmployee = (id: string) => apiSend<{ employee: Employee }>('POST', `/admin/employees/${enc(id)}/reactivate`);
