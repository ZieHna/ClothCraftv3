import type { ReactNode } from 'react';

const PATHS: Record<string, ReactNode> = {
  text: <path d="M5 6h14M12 6v13M9 19h6" />,
  picture: (
    <>
      <rect x="4" y="5" width="16" height="14" rx="1" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="m4 17 5-4 4 3 3-2 4 3" />
    </>
  ),
  rectangle: <rect x="4.5" y="7" width="15" height="10" rx="1" />,
  circle: <circle cx="12" cy="12" r="7.5" />,
  triangle: <path d="M12 5 20 19H4z" />,
  star: <path d="m12 4 2.3 5.2 5.7.5-4.3 3.8 1.3 5.6L12 16.1 7 19.1l1.3-5.6L4 9.7l5.7-.5z" />,
  line: <path d="M4 18 20 6" strokeLinecap="round" />,
  shapes: (
    <>
      <rect x="3.5" y="12" width="8" height="8" rx="1" />
      <circle cx="16.5" cy="16" r="4" />
      <path d="M12 3.5 16 10H8z" />
    </>
  ),
  layers: (
    <>
      <path d="m12 4 8 4-8 4-8-4z" />
      <path d="m4 12 8 4 8-4" />
      <path d="m4 16 8 4 8-4" />
    </>
  ),
  colour: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="9" cy="10" r="1.2" />
      <circle cx="14" cy="9" r="1.2" />
      <circle cx="15.5" cy="13.5" r="1.2" />
    </>
  ),
  more: (
    <>
      <circle cx="6" cy="12" r="1.4" />
      <circle cx="12" cy="12" r="1.4" />
      <circle cx="18" cy="12" r="1.4" />
    </>
  ),
  settings: (
    <>
      <path d="M5 8h14M5 16h14" />
      <circle cx="9" cy="8" r="2" />
      <circle cx="15" cy="16" r="2" />
    </>
  ),
  rotateLeft: (
    <>
      <path d="M5 9a8 8 0 1 1-1 5" />
      <path d="M5 4v5h5" />
    </>
  ),
  rotateRight: (
    <>
      <path d="M19 9a8 8 0 1 0 1 5" />
      <path d="M19 4v5h-5" />
    </>
  ),
  trash: (
    <>
      <path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" />
    </>
  ),
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, className = 'size-5 shrink-0' }: { name: IconName; className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round">
      {PATHS[name]}
    </svg>
  );
}
