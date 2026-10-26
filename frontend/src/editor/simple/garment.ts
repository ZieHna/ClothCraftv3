// The garment pictures. Colours are PRE-COLOURED images made at build time (scripts/make-garment-colours.mjs), so the
// editor only ever draws a picture: no per-pixel work in the browser.

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('The garment picture could not be loaded.'));
    img.src = src;
  });
}

/** Draw the garment "contained" (92% of the shorter side) in a size x size context. */
export function drawGarment(ctx: CanvasRenderingContext2D, img: HTMLImageElement, size: number): void {
  const s = Math.min(size / img.naturalWidth, size / img.naturalHeight) * 0.92;
  const w = img.naturalWidth * s;
  const h = img.naturalHeight * s;
  ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
}

/**
 * Is this a dark garment? Average brightness of its solid pixels, measured on a 32 px copy. Used to give new text a
 * readable colour (cream on dark, ink on light). Below 0.18 relative luminance cream and ink text have equal contrast.
 */
export function isDarkGarment(img: HTMLImageElement): boolean {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return false;
  drawGarment(ctx, img, 32);
  const px = ctx.getImageData(0, 0, 32, 32).data;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3]! < 200) continue;
    const lin = [px[i]!, px[i + 1]!, px[i + 2]!].map((v) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    });
    sum += 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
    n++;
  }
  return n > 0 && sum / n < 0.18;
}
