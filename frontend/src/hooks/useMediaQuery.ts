import { useSyncExternalStore } from 'react';

/** True while the media query matches. Live: follows window resizes and rotation. */
export function useMediaQuery(query: string): boolean {
  const subscribe = (onChange: () => void) => {
    const media = window.matchMedia(query);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  };
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => true);
}
