/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API?: 'mock' | 'odoo';
  readonly VITE_PROXY_TARGET?: string;
  /** shop contact address shown in the Contact section; when unset the section says details are coming */
  readonly VITE_CONTACT_EMAIL?: string;
  /** "1": loading skeletons show and leave at once (tests and the real-mode scripts' build); see src/lib/skeletonTiming.ts */
  readonly VITE_SKELETON_INSTANT?: string;
  /** "true" shows the Simple/Pro chooser and the Switch mode action; anything else (default) goes straight to Simple */
  readonly VITE_PRO_EDITOR?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
