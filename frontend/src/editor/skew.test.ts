import { describe, expect, it } from 'vitest';
import { STRAIGHTENED_NOTE, straightenSnapshot } from './skew';
import type { EditorSnapshot } from './types';

const snap = (objects: unknown[], engine: 'simple' | 'pro' = 'simple'): EditorSnapshot => ({ schemaVersion: 1, engine, state: { fabric: '7.4.0', objects, counter: 2 }, assets: {} });

describe('straightenSnapshot', () => {
  it('sets every slant to 0, changes nothing else, and counts the elements', () => {
    const { snapshot, straightened } = straightenSnapshot(snap([{ layerId: 'a', skewX: 20, skewY: 0, left: 5 }, { layerId: 'b', skewX: 0, skewY: 0 }, { layerId: 'c', skewY: -3 }]));
    expect(straightened).toBe(2);
    expect((snapshot.state as { objects: unknown[]; counter: number }).objects).toEqual([{ layerId: 'a', skewX: 0, skewY: 0, left: 5 }, { layerId: 'b', skewX: 0, skewY: 0 }, { layerId: 'c', skewX: 0, skewY: 0 }]);
    expect((snapshot.state as { counter: number }).counter).toBe(2);
  });

  it('returns a straight snapshot as it is', () => {
    const original = snap([{ layerId: 'a', skewX: 0 }]);
    expect(straightenSnapshot(original)).toEqual({ snapshot: original, straightened: 0 });
    expect(straightenSnapshot(original).snapshot).toBe(original);
  });

  it('leaves another engine and a damaged state alone (the engine refuses those itself)', () => {
    const pro = snap([{ skewX: 9 }], 'pro');
    expect(straightenSnapshot(pro).straightened).toBe(0);
    expect(straightenSnapshot({ ...pro, engine: 'simple', state: null }).straightened).toBe(0);
  });

  it('says what happened in words', () => {
    expect(STRAIGHTENED_NOTE(1)).toMatch(/^One slanted element was straightened/);
    expect(STRAIGHTENED_NOTE(3)).toMatch(/^3 slanted elements were straightened/);
  });
});
