import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

/**
 * HF-055 `public/widget.js`: the size budget (< 10 KB, no dependencies) and its behaviour in a
 * minimal fake DOM. The real-browser check (renders on a page, opens the offer in a new tab where
 * a hold completes) is e2e/embed-widget.spec.ts.
 */
const SOURCE = readFileSync(new URL('../../public/widget.js', import.meta.url), 'utf8');

class El {
  attrs = new Map<string, string>();
  children: El[] = [];
  textContent = '';
  className = '';
  href = '';
  target = '';
  rel = '';
  shadow: El | null = null;
  constructor(readonly tag: string) {}
  setAttribute(k: string, v: string) {
    this.attrs.set(k, v);
  }
  getAttribute(k: string) {
    return this.attrs.get(k) ?? null;
  }
  removeAttribute(k: string) {
    this.attrs.delete(k);
    if (k === 'href') this.href = '';
    if (k === 'target') this.target = '';
  }
  appendChild(c: El) {
    this.children.push(c);
    return c;
  }
  insertBefore(c: El) {
    this.children.unshift(c);
    return c;
  }
  attachShadow() {
    return (this.shadow = new El('#shadow'));
  }
}

async function run(attrs: Record<string, string>, status: { status: number; body?: unknown }) {
  const parent = new El('div');
  const script = new El('script') as El & { src: string; parentNode: El };
  script.src = 'https://holdfast.example/widget.js';
  script.parentNode = parent;
  for (const [k, v] of Object.entries(attrs)) script.setAttribute(k, v);
  const fetched: string[] = [];
  let settle!: () => void;
  const done = new Promise<void>((r) => (settle = r));
  const ctx = {
    document: { currentScript: script, createElement: (t: string) => new El(t) },
    location: { href: 'https://aurelaudio.example/a7' },
    URL,
    fetch: (url: string) => {
      fetched.push(url);
      const res = {
        status: status.status,
        ok: status.status >= 200 && status.status < 300,
        json: async () => status.body,
      };
      return Promise.resolve(res).finally(() => setTimeout(settle, 0));
    },
  };
  runInNewContext(SOURCE, ctx);
  if (fetched.length) await done;
  const host = parent.children[0];
  const shadow = host?.shadow;
  const link = shadow?.children.find((c) => c.tag === 'a');
  return { host, link, fetched, script };
}

describe('widget.js (HF-055)', () => {
  it('is under 10 KB and has no dependencies', () => {
    expect(Buffer.byteLength(SOURCE)).toBeLessThan(10 * 1024);
    expect(SOURCE).not.toMatch(/\bimport\b\s*[({'"]|\brequire\(/);
  });

  it('open listing: a new-tab link to the offer page with the source, from the script origin', async () => {
    const { host, link, fetched } = await run(
      { 'data-listing': 'aurel-a7', 'data-theme': 'dark', 'data-source': 'Email' },
      { status: 200, body: { biddable: true } },
    );
    expect(fetched).toEqual(['https://holdfast.example/api/widget/aurel-a7']);
    expect(host!.getAttribute('data-theme')).toBe('dark');
    expect(host!.getAttribute('data-state')).toBe('open');
    expect(link!.textContent).toBe('Make an offer');
    expect(link!.href).toBe(
      'https://holdfast.example/o/aurel-a7?utm_source=email&utm_medium=widget',
    );
    expect(link!.target).toBe('_blank');
    expect(link!.rel).toBe('noopener');
  });

  it('a malformed source falls back to "widget"; data-label sets the text', async () => {
    const { link } = await run(
      { 'data-listing': 'aurel-a7', 'data-source': 'a b"><x', 'data-label': 'Name your price' },
      { status: 200, body: { biddable: true } },
    );
    expect(link!.href).toContain('utm_source=widget&');
    expect(link!.textContent).toBe('Name your price');
  });

  it('not biddable (D7) or unknown listing: "Offers closed", no link', async () => {
    for (const status of [{ status: 200, body: { biddable: false } }, { status: 404 }]) {
      const { host, link } = await run({ 'data-listing': 'aurel-a7' }, status);
      expect(link!.textContent).toBe('Offers closed');
      expect(link!.href).toBe('');
      expect(link!.getAttribute('aria-disabled')).toBe('true');
      expect(host!.getAttribute('data-state')).toBe('closed');
    }
  });

  it('status check fails: the button stays (the offer page shows the real state)', async () => {
    const { link } = await run({ 'data-listing': 'aurel-a7' }, { status: 503 });
    expect(link!.textContent).toBe('Make an offer');
    expect(link!.href).toMatch(/\/o\/aurel-a7\?/);
  });

  it('no data-listing: renders nothing and makes no request', async () => {
    const { host, fetched } = await run({}, { status: 200 });
    expect(host).toBeUndefined();
    expect(fetched).toEqual([]);
  });
});
