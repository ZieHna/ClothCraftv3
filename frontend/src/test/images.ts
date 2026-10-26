// Test pictures. The real ones are decodable 24x16 images (fixtures.ts). The synthetic ones are HEADER ONLY: just enough
// bytes to state a size, so tests can prove an over-limit picture is refused from its header without anything decoding it.
import { JPEG_B64, PNG_B64, WEBP_B64 } from './fixtures';

const bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
export const realPng = (type = 'image/png') => new Blob([bytes(PNG_B64)], { type });
export const realJpeg = (type = 'image/jpeg') => new Blob([bytes(JPEG_B64)], { type });
export const realWebp = (type = 'image/webp') => new Blob([bytes(WEBP_B64)], { type });

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** 29 bytes: PNG signature + an IHDR chunk that claims width x height. No pixel data at all. */
export function pngHeader(width: number, height: number, type = 'image/png'): Blob {
  return new Blob([new Uint8Array([0x89, ...ascii('PNG'), 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), ...ascii('IHDR'), ...be32(width), ...be32(height), 8, 6, 0, 0, 0])], { type });
}

/** SOI, a JFIF APP0, then SOF0 stating the size. No scan data. */
export function jpegHeader(width: number, height: number, type = 'image/jpeg'): Blob {
  const app0 = [0xff, 0xe0, 0, 16, ...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sof0 = [0xff, 0xc0, 0, 17, 8, (height >> 8) & 255, height & 255, (width >> 8) & 255, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return new Blob([new Uint8Array([0xff, 0xd8, ...app0, ...sof0])], { type });
}

/** RIFF/WEBP with a VP8X chunk stating the canvas size. */
export function webpHeader(width: number, height: number, type = 'image/webp'): Blob {
  const le24 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255];
  const vp8x = [...ascii('VP8X'), 10, 0, 0, 0, 0, 0, 0, 0, ...le24(width - 1), ...le24(height - 1)];
  const size = 4 + vp8x.length;
  return new Blob([new Uint8Array([...ascii('RIFF'), size & 255, (size >> 8) & 255, 0, 0, ...ascii('WEBP'), ...vp8x])], { type });
}

export const svgBlob = (type = 'image/svg+xml') => new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'], { type });
export const gifBlob = () => new Blob([new Uint8Array([...ascii('GIF89a'), 1, 0, 1, 0, 0, 0, 0, 0x3b])], { type: 'image/gif' });
