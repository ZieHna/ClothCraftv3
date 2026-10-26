import { useAuth } from '../auth/AuthContext';
import { DraftsList } from '../components/DraftsList';
import { OrdersList } from '../components/OrdersList';
import { RequireAccount } from '../components/RequireAccount';

/** The account page: who is signed in, their orders and their saved designs. */
export function Account() {
  const { user } = useAuth();
  return (
    <RequireAccount what="see your account">
      <section className="mx-auto max-w-6xl px-4 py-10">
        <h1 className="text-5xl">Account</h1>
        <p className="mt-4 max-w-prose text-lg" data-testid="account-signed-in">
          Signed in as {user?.displayName}
          <span className="text-muted"> ({user?.email})</span>.
        </p>
        <OrdersList />
        <DraftsList />
      </section>
    </RequireAccount>
  );
}
