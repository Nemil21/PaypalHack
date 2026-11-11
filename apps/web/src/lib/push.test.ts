import { describe, expect, it } from 'vitest';
import {
  isIOSUserAgent,
  parseAroundCents,
  pushState,
  subscribePath,
  urlBase64ToUint8Array,
  type PushEnvironment,
} from './push';

const env = (over: Partial<PushEnvironment> = {}): PushEnvironment => ({
  hasServiceWorker: true,
  hasPushManager: true,
  hasNotification: true,
  isIOS: false,
  standalone: false,
  permission: 'default',
  vapidPublicKey: 'BKey',
  subscribed: false,
  ...over,
});

describe('HF-054b push state', () => {
  it('Android Chrome tab: off, then on once granted and subscribed', () => {
    expect(pushState(env())).toBe('off');
    expect(pushState(env({ permission: 'granted', subscribed: true }))).toBe('on');
    // Subscribed but permission later revoked to default: off (re-ask).
    expect(pushState(env({ permission: 'default', subscribed: true }))).toBe('off');
  });

  it('iOS needs the Home Screen app first; installed it behaves like Android', () => {
    expect(pushState(env({ isIOS: true, hasPushManager: false }))).toBe('needs-install');
    expect(pushState(env({ isIOS: true, standalone: true }))).toBe('off');
  });

  it('unsupported, server off, denied', () => {
    expect(pushState(env({ hasPushManager: false }))).toBe('unsupported');
    expect(pushState(env({ vapidPublicKey: null }))).toBe('server-off');
    expect(pushState(env({ permission: 'denied' }))).toBe('denied');
  });

  it('detects iPhone and iPadOS-as-Mac', () => {
    expect(isIOSUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe(true);
    expect(isIOSUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5)).toBe(true);
    expect(isIOSUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0)).toBe(false);
    expect(isIOSUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8)')).toBe(false);
  });

  it('decodes a URL-safe base64 VAPID key', () => {
    expect([...urlBase64ToUint8Array('AQID_-8')]).toEqual([1, 2, 3, 255, 239]);
  });

  it('parses the push ?around= amount defensively', () => {
    expect(parseAroundCents('21900')).toBe(21900);
    for (const bad of [null, '', '-5', '1e5', '21900.5', '0', '99999999999']) {
      expect(parseAroundCents(bad)).toBeNull();
    }
  });

  it('paths', () => {
    expect(subscribePath('shopper', 'subscribe')).toBe('/api/notifications/subscribe');
    expect(subscribePath('brand', 'push-test')).toBe('/api/notifications/push-test?as=brand');
  });
});
