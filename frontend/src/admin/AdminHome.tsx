import { Link } from 'react-router';

/** The admin area's "no such page". (The dashboard itself is admin/dashboard/DashboardPage.tsx; the step 7a placeholder is retired.) */
export function AdminNotFound() {
  return (
    <section className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-4xl sm:text-5xl">Page not found</h1>
      <p className="mt-3 text-lg">There is no such page in the admin dashboard.</p>
      <Link to="/admin" className="btn btn-primary mt-5">
        Admin home
      </Link>
    </section>
  );
}
