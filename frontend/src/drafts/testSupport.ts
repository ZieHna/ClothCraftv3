// Helpers shared by the drafts tests (jsdom).
import { FakeEditor } from '../editor/fake/FakeEditor';
import type { GarmentBase } from '../editor/types';
import { PNG_B64 } from '../test/fixtures';

export const GARMENT: GarmentBase = {
  image: '/garments/m-tee/white.webp',
  color: 'white',
  size: 'M',
  colorImages: { white: '/garments/m-tee/white.webp', navy: '/garments/m-tee/navy.webp' },
};

/** jsdom has <dialog> but not showModal/close behaviour. This gives it the parts the drafts prompt relies on. */
export function polyfillDialog(): void {
  const proto = HTMLDialogElement.prototype;
  proto.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
    this.querySelector<HTMLElement>('[autofocus], button')?.focus(); // what a browser does: the first control gets focus
  };
  proto.close = function close(this: HTMLDialogElement) {
    if (!this.hasAttribute('open')) return;
    this.removeAttribute('open');
    queueMicrotask(() => this.dispatchEvent(new Event('close')));
  };
}

export async function newEditor(): Promise<FakeEditor> {
  const editor = new FakeEditor();
  await editor.loadBase(GARMENT);
  return editor;
}

export function png(): Blob {
  const bytes = Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: 'image/png' });
}

export function pageHidden(hidden: boolean): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
  document.dispatchEvent(new Event('visibilitychange'));
}
