// Image upload checks. Everything here looks at the file's BYTES, never at its name or its claimed MIME type, and reads
// only the header: an over-limit picture is refused before anything decodes it (a 40+ megapixel image decodes to over
// 160 MB). Pure functions on a Blob, so they run in jsdom as well as in the browser. No server is involved.

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // about 10 MB
export const MAX_UPLOAD_PIXELS = 40_000_000; // 40 megapixels
/** After loading, the long edge is brought down to this (the design area is 800 units; 2000 px is ample for print). */
export const MAX_LONG_EDGE = 2000;

export type ImageKind = 'png' | 'jpeg' | 'webp';
export const MIME_OF: Record<ImageKind, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };

export type UploadProblem = 'not-an-image' | 'svg' | 'gif' | 'unsupported' | 'damaged' | 'too-big' | 'too-many-pixels';

/** Carries a sentence that is safe to show to the person as it is. */
export class UploadError extends Error {
  constructor(
    readonly problem: UploadProblem,
    message: string,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

export interface ImageInfo {
  kind: ImageKind;
  width: number;
  height: number;
}

const HEADER_BYTES = 1 << 20; // 1 MB is far more than any PNG or WebP header; JPEG metadata can be long before its size
const ONLY = 'Use a PNG, JPEG or WebP picture.';

const ascii = (b: Uint8Array, at: number, text: string) => text.split('').every((c, i) => b[at + i] === c.charCodeAt(0));
const u16be = (b: Uint8Array, at: number) => (b[at]! << 8) | b[at + 1]!;
const u32be = (b: Uint8Array, at: number) => ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
const u24le = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16);

/** What the file is, by its first bytes. */
function sniff(b: Uint8Array): ImageKind {
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 'PNG') && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 12 && ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) return 'webp';
  if (ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a')) throw new UploadError('gif', `GIF pictures are not supported. ${ONLY}`);
  // SVG is text: "<svg ...", "<?xml ...", maybe after a byte-order mark or whitespace
  const head = new TextDecoder('utf-8', { fatal: false }).decode(b.subarray(0, 512)).replace(/^﻿/, '').trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg')) || head.startsWith('<!doctype svg')) {
    throw new UploadError('svg', `SVG files are not supported, because they can carry scripts. ${ONLY}`);
  }
  if (b.length === 0) throw new UploadError('not-an-image', 'That file is empty.');
  throw new UploadError('not-an-image', `That file is not a picture this editor can use. ${ONLY}`);
}

function pngSize(b: Uint8Array): [number, number] {
  // signature(8) + length(4) + "IHDR"(4) + width(4) + height(4)
  if (b.length < 24 || !ascii(b, 12, 'IHDR')) throw damaged();
  return [u32be(b, 16), u32be(b, 20)];
}

function jpegSize(b: Uint8Array): [number, number] {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) throw damaged();
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i++; // fill byte
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2; // markers with no length
      continue;
    }
    const length = u16be(b, i + 2);
    // SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC): precision(1) height(2) width(2)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return [u16be(b, i + 7), u16be(b, i + 5)];
    if (marker === 0xda) break; // start of scan: no size marker came before the picture data
    i += 2 + length;
  }
  throw damaged();
}

function webpSize(b: Uint8Array): [number, number] {
  if (b.length < 30) throw damaged();
  if (ascii(b, 12, 'VP8X')) return [u24le(b, 24) + 1, u24le(b, 27) + 1];
  if (ascii(b, 12, 'VP8L')) {
    if (b[20] !== 0x2f) throw damaged();
    const bits = (b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 0;
    return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
  }
  if (ascii(b, 12, 'VP8 ')) {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) throw damaged();
    return [(b[26]! | (b[27]! << 8)) & 0x3fff, (b[28]! | (b[29]! << 8)) & 0x3fff];
  }
  throw damaged();
}

const damaged = () => new UploadError('damaged', 'That picture looks damaged, so it cannot be used.');

/**
 * Judges a file from its bytes: signature, then size in bytes, then the width and height written in its header, then
 * the pixel count. Reads at most 1 MB and decodes nothing. Throws UploadError with a sentence for the person.
 */
export async function inspectImage(file: Blob): Promise<ImageInfo> {
  const b = new Uint8Array(await file.slice(0, HEADER_BYTES).arrayBuffer());
  const kind = sniff(b);
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new UploadError('too-big', `That picture is ${(file.size / 1048576).toFixed(1)} MB. The most this editor takes is ${MAX_UPLOAD_BYTES / 1048576} MB.`);
  }
  const [width, height] = kind === 'png' ? pngSize(b) : kind === 'jpeg' ? jpegSize(b) : webpSize(b);
  if (width < 1 || height < 1) throw damaged();
  if (width * height > MAX_UPLOAD_PIXELS) {
    throw new UploadError(
      'too-many-pixels',
      `That picture is ${width} by ${height} pixels (${((width * height) / 1e6).toFixed(0)} megapixels). The most this editor takes is ${MAX_UPLOAD_PIXELS / 1e6} megapixels.`,
    );
  }
  return { kind, width, height };
}

/** The size a picture is brought down to on load: the long edge at most MAX_LONG_EDGE, never enlarged. */
export function downscaledSize(width: number, height: number): { width: number; height: number; scaled: boolean } {
  const k = Math.min(1, MAX_LONG_EDGE / Math.max(width, height));
  if (k === 1) return { width, height, scaled: false };
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)), scaled: true };
}
