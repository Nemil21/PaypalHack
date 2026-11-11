import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { color, radius } from './tokens.js';

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const cssVar = (name: string) => new RegExp(`--${name}:\\s*([^;]+);`).exec(css)?.[1]?.trim();

describe('v3 tokens', () => {
  it('spot-checks the Figma v3 page values', () => {
    // Read off "Holdfast — v3": PLACE A BID fill, FOR BRANDS fill, headline, nav link, receipt
    // "Released to you" amount.
    expect(color.orange).toBe('#f26b2c');
    expect(color.charcoal).toBe('#2b2b2b');
    expect(color.ink).toBe('#141414');
    expect(color.body).toBe('#4a4a4a');
    expect(color.success).toBe('#3f8f5b');
    expect(radius).toEqual({ sm: 2, md: 4 });
  });

  it('declares every colour token in styles.css with the same value', () => {
    for (const [name, value] of Object.entries(color)) {
      expect(cssVar(`color-${kebab(name)}`), name).toBe(value);
    }
  });

  it('declares the radii and a 4 px spacing unit', () => {
    expect(cssVar('radius-sm')).toBe(`${radius.sm}px`);
    expect(cssVar('radius-md')).toBe(`${radius.md}px`);
    expect(cssVar('spacing')).toBe('4px');
  });
});
