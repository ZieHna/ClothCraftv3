import { Link } from 'react-router';

export function StaffNotFound() {
  return (
    <section className="mx-auto max-w-6xl px-4 py-10">
      <h1 className="text-4xl sm:text-5xl">Page not found</h1>
      <p className="mt-3 text-lg">There is no such page in the staff dashboard.</p>
      <Link to="/staff" className="btn btn-primary mt-5">
        All orders
      </Link>
    </section>
  );
}
