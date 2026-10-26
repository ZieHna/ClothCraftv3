import { Navigate, useLocation } from 'react-router';

/**
 * The page was called Browse until step A and is Category now (/category). Old links, bookmarks and e-mails to /browse keep working: the
 * visitor lands on the same page with the same query string (?group=Men&stock=1) and #hash, and the old address is replaced in the history
 * (so Back does not return to a redirect).
 */
export function BrowseRedirect() {
  const { search, hash } = useLocation();
  return <Navigate to={{ pathname: '/category', search, hash }} replace />;
}
