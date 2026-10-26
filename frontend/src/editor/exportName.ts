// Names for downloaded pictures: what it is of, when, and which of the two files it is.
//   men-crew-tee-navy-M-2026-10-21-preview-2x.png      the design on the garment (a small garment photo: to look at)
//   men-crew-tee-navy-M-2026-10-21-design-only-2x.png  the design alone on a transparent background (to print from)

export type ExportKind = 'preview' | 'design';

export const slug = (text: string): string =>
  text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'design';

const two = (n: number) => String(n).padStart(2, '0');
/** the person's own calendar day, not UTC: a file made at 11 pm is dated that day */
export const localDate = (d: Date) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;

export function exportFileName(o: { product: string; color: string; size: string; kind: ExportKind; scale: number; date?: Date }): string {
  const kind = o.kind === 'preview' ? 'preview' : 'design-only';
  return `${slug(o.product)}-${slug(o.color)}-${slug(o.size).toUpperCase()}-${localDate(o.date ?? new Date())}-${kind}-${o.scale}x.png`;
}

/** Saves a Blob as a file: an invisible link, clicked, then cleaned up. Nothing is sent anywhere. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
