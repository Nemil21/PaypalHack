import { describe, expect, it } from 'vitest';
import {
  setShortcutsEnabled,
  shortcutFor,
  shortcutsEnabled,
  type KeyEventLike,
} from './shortcuts.js';

const body = { tag: 'BODY' };
const html = { tag: 'HTML' };
const doc = { body, documentElement: html };

const key = (k: string, over: Partial<KeyEventLike> = {}): KeyEventLike => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  repeat: false,
  defaultPrevented: false,
  target: body,
  ...over,
});

describe('shortcutFor', () => {
  it('maps b and p when nothing is focused', () => {
    expect(shortcutFor(key('b'), doc)).toBe('brand');
    expect(shortcutFor(key('p'), doc)).toBe('bid');
    expect(shortcutFor(key('p', { target: html }), doc)).toBe('bid');
    expect(shortcutFor(key('x'), doc)).toBeNull();
  });

  it('ignores keys while any element has focus (AG Grid cell, Studio menu, textbox widget)', () => {
    for (const target of [{ role: 'gridcell' }, { role: 'menu' }, { role: 'textbox' }, {}]) {
      expect(shortcutFor(key('p', { target }), doc)).toBeNull();
    }
  });

  it('ignores handled, repeated and modified keys, including Shift', () => {
    expect(shortcutFor(key('p', { defaultPrevented: true }), doc)).toBeNull();
    expect(shortcutFor(key('p', { repeat: true }), doc)).toBeNull();
    expect(shortcutFor(key('P', { shiftKey: true }), doc)).toBeNull();
    for (const mod of ['metaKey', 'ctrlKey', 'altKey'] as const) {
      expect(shortcutFor(key('b', { [mod]: true }), doc)).toBeNull();
    }
  });
});

describe('shortcuts preference', () => {
  it('defaults on and persists an opt-out', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    expect(shortcutsEnabled(storage)).toBe(true);
    setShortcutsEnabled(storage, false);
    expect(shortcutsEnabled(storage)).toBe(false);
    setShortcutsEnabled(storage, true);
    expect(shortcutsEnabled(storage)).toBe(true);
    expect(shortcutsEnabled(undefined)).toBe(true);
  });
});
