import type { ReactNode } from 'react';

/** A deliberate empty state: what is missing, in the server's words where it has them, and what to do about it. Not a "coming soon". */
export function DssEmpty({ title, children, testId }: { title: string; children?: ReactNode; testId?: string }) {
  return (
    <div className="border-2 border-dashed border-tan bg-paper p-4" data-testid={testId ?? 'dss-empty'}>
      <p className="font-medium text-ink">{title}</p>
      {children && <p className="mt-1 text-sm text-muted">{children}</p>}
    </div>
  );
}
