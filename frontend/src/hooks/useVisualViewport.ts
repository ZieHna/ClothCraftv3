import { useEffect, useState } from 'react';

/**
 * Follows the visual viewport (what is really visible, which shrinks when the on-screen keyboard opens) and publishes it
 * as CSS variables, so bottom sheets can sit above the keyboard and shrink to fit instead of being covered:
 *   --vv-h       the visible height in px
 *   --vv-bottom  how far the bottom of the visible area is above the bottom of the layout viewport (the keyboard's height)
 * Returns true while the keyboard looks open: the visible area is clearly shorter than the window AND a text field has focus.
 * Only active while `enabled` (the phone layout).
 */
export function useVisualViewport(enabled: boolean): boolean {
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!enabled || !vv) return;
    const root = document.documentElement;
    const update = () => {
      const bottom = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      root.style.setProperty('--vv-h', `${Math.round(vv.height)}px`);
      root.style.setProperty('--vv-bottom', `${Math.round(bottom)}px`);
      const el = document.activeElement;
      const typing = !!el && el.matches('input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]):not([type=file]), textarea');
      setKeyboardOpen(bottom > 120 && typing);
    };
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      document.removeEventListener('focusin', update);
      document.removeEventListener('focusout', update);
      root.style.removeProperty('--vv-h');
      root.style.removeProperty('--vv-bottom');
      setKeyboardOpen(false);
    };
  }, [enabled]);
  return keyboardOpen;
}
