import { Link } from 'react-router';

export function NotFound() {
  return (
    <section className="mx-auto max-w-6xl px-4 py-10">
      <h1 className="text-5xl">Page not found</h1>
      <p className="mt-4 text-lg">
        <Link to="/" className="text-sage-dark underline">
          Back to the start
        </Link>
      </p>
    </section>
  );
}
