import { describe, expect, it } from 'vitest';
import { domainSchema, normalizeDomain } from './domain.js';

describe('normalizeDomain (HF-011a)', () => {
  it.each<[string, string]>([
    ['aurelaudio.example', 'aurelaudio.example'],
    ['AurelAudio.Example', 'aurelaudio.example'],
    ['  aurelaudio.example  ', 'aurelaudio.example'],
    ['https://aurelaudio.example', 'aurelaudio.example'],
    ['http://aurelaudio.example/', 'aurelaudio.example'],
    ['HTTPS://WWW.AurelAudio.example/shop/a7?ref=x#top', 'aurelaudio.example'],
    ['www.aurelaudio.example', 'aurelaudio.example'],
    ['//www.aurelaudio.example/path', 'aurelaudio.example'],
    ['aurelaudio.example:8443/x', 'aurelaudio.example'],
    ['https://user:pw@aurelaudio.example', 'aurelaudio.example'],
    ['aurelaudio.example.', 'aurelaudio.example'],
    ['shop.aurelaudio.example', 'shop.aurelaudio.example'],
    ['www2.aurelaudio.example', 'www2.aurelaudio.example'],
    ['xn--bcher-kva.example', 'xn--bcher-kva.example'],
    ['aurel-audio.co.uk', 'aurel-audio.co.uk'],
  ])('%j → %j', (input, expected) => {
    expect(normalizeDomain(input)).toBe(expected);
  });

  it('only strips one leading www. label', () => {
    expect(normalizeDomain('www.www.aurelaudio.example')).toBe('www.aurelaudio.example');
  });

  it.each([
    '',
    '   ',
    'localhost',
    'https://',
    'www.example', // www. stripped leaves a single label
    'aurel audio.example',
    '-aurel.example',
    'aurel-.example',
    'aurel..example',
    'aurel_audio.example',
    '10.0.0.1',
    'bücher.example',
    `${'a'.repeat(64)}.example`,
    `${'a.'.repeat(127)}example`,
  ])('rejects %j', (input) => {
    expect(normalizeDomain(input)).toBeNull();
  });

  it('is idempotent', () => {
    for (const s of ['https://www.AurelAudio.example/x', 'shop.aurelaudio.example']) {
      const once = normalizeDomain(s)!;
      expect(normalizeDomain(once)).toBe(once);
    }
  });

  it('domainSchema normalises or fails validation', () => {
    expect(domainSchema.parse('https://www.AurelAudio.example/')).toBe('aurelaudio.example');
    const bad = domainSchema.safeParse('not a domain');
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.message).toMatch(/website domain/);
  });
});
