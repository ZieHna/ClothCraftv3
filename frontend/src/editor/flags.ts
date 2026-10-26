/** Pro editor feature flag. Read on every call so tests can change it; off unless VITE_PRO_EDITOR is exactly "true". */
export function isProEditorEnabled(): boolean {
  return import.meta.env.VITE_PRO_EDITOR === 'true';
}

/** Below Tailwind's `sm` breakpoint. Pro is desktop-only. */
export const PHONE_QUERY = '(max-width: 639.98px)';
