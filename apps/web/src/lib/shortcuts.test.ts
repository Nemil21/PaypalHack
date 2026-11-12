import { describe, expect, it } from 'vitest';
import {
  setShortcutsEnabled,
  shortcutFor,
  shortcutsEnabled,
  shortcutsHint,
  type KeyEventLike,
} from './shortcuts.js';
import { DEMO_OFFER_SLUG, paths } from './routes.js';

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

const to = (k: string, role: 'brand' | 'buyer' | 'public', over: Partial<KeyEventLike> = {}) =>
  shortcutFor(key(k, over), doc, role)?.to ?? null;

describe('shortcutFor', () => {
  it('brand: S opens brand settings, P opens payouts', () => {
    expect(to('s', 'brand')).toBe(paths.brandSettings);
    expect(to('p', 'brand')).toBe(paths.brandPayouts);
    expect(to('p', 'brand', { target: html })).toBe(paths.brandPayouts);
    expect(to('b', 'brand')).toBeNull();
  });

  it('buyer: P places a bid, S opens buyer settings', () => {
    expect(to('p', 'buyer')).toBe(paths.offer(DEMO_OFFER_SLUG));
    expect(to('s', 'buyer')).toBe(paths.settings);
    expect(to('b', 'buyer')).toBeNull();
  });

  it('public nav has no shortcuts', () => {
    expect(to('p', 'public')).toBeNull();
    expect(to('s', 'public')).toBeNull();
    expect(shortcutsHint('public')).toBeNull();
  });

  it('names the keys for the on/off toggle', () => {
    expect(shortcutsHint('brand')).toBe('S settings, P payouts');
    expect(shortcutsHint('buyer')).toBe('P place a bid, S settings');
  });

  it('ignores keys while any element has focus (AG Grid cell, Studio menu, textbox widget)', () => {
    for (const target of [{ role: 'gridcell' }, { role: 'menu' }, { role: 'textbox' }, {}]) {
      expect(to('p', 'buyer', { target })).toBeNull();
      expect(to('s', 'brand', { target })).toBeNull();
    }
  });

  it('ignores handled, repeated and modified keys, including Shift', () => {
    expect(to('p', 'buyer', { defaultPrevented: true })).toBeNull();
    expect(to('p', 'buyer', { repeat: true })).toBeNull();
    expect(to('P', 'buyer', { shiftKey: true })).toBeNull();
    for (const mod of ['metaKey', 'ctrlKey', 'altKey'] as const) {
      expect(to('s', 'brand', { [mod]: true })).toBeNull();
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
