import { Link } from 'react-router';
import type { Group } from '../api/types';

const GROUPS: Group[] = ['Men', 'Women', 'Kids', 'Babies'];
const linkClass = 'underline decoration-paper-warm/40 underline-offset-4 hover:decoration-paper-warm';

export function Footer() {
  return (
    <footer className="bg-ink text-paper-warm">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 sm:grid-cols-3">
        <div>
          <p className="font-display text-3xl font-bold italic">ClothCraft</p>
          <p className="mt-2 max-w-xs text-sm">Pick a garment, make it yours, and have it delivered.</p>
        </div>
        <nav aria-label="Shop by category">
          <p className="eyebrow text-sage-light!">Shop</p>
          <ul className="mt-3 space-y-1.5">
            {GROUPS.map((group) => (
              <li key={group}>
                <Link to={`/category?group=${group}`} className={linkClass}>
                  {group}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <nav aria-label="Site">
          <p className="eyebrow text-sage-light!">Site</p>
          <ul className="mt-3 space-y-1.5">
            <li>
              <Link to={{ pathname: '/', hash: '#how-it-works' }} className={linkClass}>
                How it works
              </Link>
            </li>
            <li>
              <Link to="/design" className={linkClass}>
                Design your own
              </Link>
            </li>
            <li>
              <Link to={{ pathname: '/', hash: '#contact' }} className={linkClass}>
                Contact
              </Link>
            </li>
          </ul>
        </nav>
      </div>
      <div className="border-t border-paper-warm/25 px-4 py-4 text-center text-sm">
        <p>© {new Date().getFullYear()} ClothCraft</p>
      </div>
    </footer>
  );
}

/**
 * One line, for the designer on a large desktop window (the editor fills the window there, so a full footer would push it
 * off the screen). It keeps the copyright; the links that the full footer repeats are all in the header.
 */
export function FooterSlim() {
  return (
    <footer className="shrink-0 bg-ink text-paper-warm">
      <div className="mx-auto flex max-w-[105rem] flex-wrap items-center justify-center gap-x-5 gap-y-0.5 px-4 py-1.5 text-center text-xs">
        <p>© {new Date().getFullYear()} ClothCraft</p>
      </div>
    </footer>
  );
}
