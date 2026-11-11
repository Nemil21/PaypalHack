import { describe, expect, it } from 'vitest';
import { claimChunkReload, isChunkLoadError } from './chunk-reload';

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  };
}

describe('isChunkLoadError', () => {
  it('matches the Chrome, Firefox and Safari wording', () => {
    expect(
      isChunkLoadError(
        new TypeError('Failed to fetch dynamically imported module: /assets/Brand-x1.js'),
      ),
    ).toBe(true);
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module'))).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
  });

  it('ignores ordinary errors', () => {
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isChunkLoadError({ status: 404 })).toBe(false);
  });
});

describe('claimChunkReload', () => {
  it('reloads once, then not again within 30 s', () => {
    const s = memoryStorage();
    expect(claimChunkReload(s, 1_000_000)).toBe(true);
    expect(claimChunkReload(s, 1_010_000)).toBe(false);
    expect(claimChunkReload(s, 1_031_000)).toBe(true);
  });

  it('never reloads without storage (no loop guard)', () => {
    expect(claimChunkReload(undefined)).toBe(false);
  });
});
