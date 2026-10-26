import type { DesignEditor, EditorMode, SimpleEditorTools } from './types';

/**
 * One factory, two engines behind the same DesignEditor core interface. Only "simple" exists, and it also offers the
 * Simple tools (SimpleEditorTools). The Simple adapter is a lazy chunk and it loads Fabric with its own dynamic
 * import(), so no page gains Fabric bytes until an editor is created. "pro" loads nothing and rejects.
 */
export async function createEditor(mode: 'simple', host: HTMLElement): Promise<SimpleEditorTools>;
export async function createEditor(mode: EditorMode, host: HTMLElement): Promise<DesignEditor>;
export async function createEditor(mode: EditorMode, host: HTMLElement): Promise<DesignEditor> {
  if (mode === 'simple') {
    const { createSimpleEditor } = await import('./simple/SimpleEditor');
    return createSimpleEditor(host);
  }
  throw new Error('The Pro editor is not available yet.');
}
