import type { ReactNode } from 'react';
import { useAuth } from '../auth/AuthContext';

/**
 * Pages that need an account (designing, saving a design: a design has an owner). Browsing never does.
 * With no session it shows a prompt that opens the sign-in or register dialog. While a returning visitor's session is still being
 * checked it shows nothing but a short status line (or, when the page passes `checking`, that page's own skeleton: the same one its lazy
 * route and its data loading show, so the page does not shrink to a line and grow back), so a signed-in customer never sees the prompt flash up.
 */
const WHY_DESIGN = 'A design belongs to its owner, so designing and saving need an account. Browsing the catalogue never does.';

export function RequireAccount({ what, why = WHY_DESIGN, checking, children }: { what: string; why?: string; checking?: ReactNode; children: ReactNode }) {
  const { user, status, openSignIn, openRegister } = useAuth();
  if (user) return <>{children}</>;
  if (status === 'loading') {
    if (checking) return <>{checking}</>;
    return (
      <p role="status" className="mx-auto max-w-3xl px-4 py-16 text-muted">
        Checking your sign-in…
      </p>
    );
  }
  return (
    <section className="mx-auto max-w-3xl px-4 py-16">
      <div className="stitched taped relative border border-tan bg-cream p-8 sm:p-10">
        <p className="eyebrow">Account needed</p>
        <h1 className="mt-2 text-5xl">Sign in to {what}.</h1>
        <p className="mt-4 max-w-prose text-lg">{why}</p>
        <div className="mt-6 flex flex-wrap gap-3">
          <button type="button" onClick={() => openSignIn()} className="btn btn-primary">
            Sign in
          </button>
          <button type="button" onClick={() => openRegister()} className="btn btn-secondary">
            Register
          </button>
        </div>
      </div>
    </section>
  );
}
