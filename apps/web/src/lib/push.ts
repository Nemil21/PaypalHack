import { MAX_AMOUNT_CENTS, MIN_AMOUNT_CENTS } from '@holdfast/shared';
import { api, ApiAction } from './api';
import { clientConfig } from './client-config';
import type { Audience } from './notifications';

/**
 * Web push in the browser (HF-054b; features/13 §Channels, api.md `POST /notifications/subscribe`).
 * The service worker is `/sw.js` (apps/web/public). Phones: Android Chrome works from the site;
 * iOS / iPadOS 16.4+ only from the app added to the Home Screen (an installed PWA), so there the
 * toggle first explains how to install.
 */

export const SERVICE_WORKER_URL = '/sw.js';

export type PushState =
  /** No Push API in this browser. */
  | 'unsupported'
  /** iOS Safari tab: push needs Add to Home Screen first. */
  | 'needs-install'
  /** The server has no VAPID keys. */
  | 'server-off'
  /** The user blocked notifications for this site. */
  | 'denied'
  | 'off'
  | 'on';

export interface PushEnvironment {
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
  isIOS: boolean;
  /** Launched from the Home Screen (display-mode standalone / navigator.standalone). */
  standalone: boolean;
  permission: NotificationPermission | null;
  vapidPublicKey: string | null;
  /** This browser already has a push subscription. */
  subscribed: boolean;
}

export function pushState(env: PushEnvironment): PushState {
  // iOS Safari has no PushManager in a tab, only in the installed app: say how to get it.
  if (env.isIOS && !env.standalone) return 'needs-install';
  if (!env.hasServiceWorker || !env.hasPushManager || !env.hasNotification) return 'unsupported';
  if (!env.vapidPublicKey) return 'server-off';
  if (env.permission === 'denied') return 'denied';
  return env.subscribed && env.permission === 'granted' ? 'on' : 'off';
}

export const PUSH_STATE_COPY: Record<PushState, string> = {
  unsupported:
    "This browser can't show phone alerts. Try Chrome on Android, or Safari on iPhone after adding Holdfast to your Home Screen.",
  'needs-install':
    'On iPhone, alerts work from the Home Screen app: tap Share, then "Add to Home Screen", and open Holdfast from there (iOS 16.4 or later).',
  'server-off': 'Phone alerts are not set up on this server yet.',
  denied:
    'Notifications are blocked for this site. Allow them in your browser settings, then try again.',
  off: 'Get price drops, raise prompts and results on this device, even when Holdfast is closed.',
  on: 'Alerts are on for this device.',
};

/** iPhone / iPad, including iPadOS reporting itself as a Mac with touch. */
export function isIOSUserAgent(ua: string, maxTouchPoints = 0): boolean {
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1);
}

/** VAPID keys are URL-safe base64; `PushManager.subscribe` wants the raw bytes. */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** `?around=21900` from a `below_clearing` push: whole cents within bid limits, else null. */
export function parseAroundCents(raw: string | null): number | null {
  if (!raw || !/^\d{1,9}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= MIN_AMOUNT_CENTS && n <= MAX_AMOUNT_CENTS ? n : null;
}

export function subscribePath(
  audience: Audience,
  action: 'subscribe' | 'unsubscribe' | 'push-test',
) {
  return `/api/notifications/${action}${audience === 'brand' ? '?as=brand' : ''}`;
}

// --- Browser side -------------------------------------------------------------------------------

function hasSW(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
}

/** Register `/sw.js` once at boot (harmless where push is unsupported). */
export function registerServiceWorker(): void {
  if (!hasSW() || !window.isSecureContext) return;
  void navigator.serviceWorker.register(SERVICE_WORKER_URL).catch(() => {
    // No worker, no push; the toggle reports "unsupported" on use.
  });
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!hasSW()) return null;
  return (
    (await navigator.serviceWorker.getRegistration()) ??
    (await navigator.serviceWorker.register(SERVICE_WORKER_URL).catch(() => null))
  );
}

export async function currentEnvironment(): Promise<PushEnvironment> {
  const nav = navigator as Navigator & { standalone?: boolean };
  const reg = await registration();
  const sub = reg && 'pushManager' in reg ? await reg.pushManager.getSubscription() : null;
  return {
    hasServiceWorker: hasSW(),
    hasPushManager: typeof window !== 'undefined' && 'PushManager' in window,
    hasNotification: typeof Notification !== 'undefined',
    isIOS: isIOSUserAgent(navigator.userAgent, navigator.maxTouchPoints),
    standalone:
      nav.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches === true,
    permission: typeof Notification !== 'undefined' ? Notification.permission : null,
    vapidPublicKey: clientConfig().vapidPublicKey,
    subscribed: sub !== null,
  };
}

/**
 * Ask for permission (must run in a tap handler on iOS), subscribe this browser and store it.
 * Returns the resulting state.
 */
export async function enablePush(audience: Audience): Promise<PushState> {
  const key = clientConfig().vapidPublicKey;
  const reg = await registration();
  if (!key || !reg) return pushState(await currentEnvironment());
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return pushState(await currentEnvironment());
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key),
    }));
  await new ApiAction(api).run({
    method: 'POST',
    path: subscribePath(audience, 'subscribe'),
    body: { subscription: sub.toJSON() },
  });
  return 'on';
}

export async function disablePush(audience: Audience): Promise<PushState> {
  const reg = await registration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (sub) {
    await new ApiAction(api)
      .run({
        method: 'POST',
        path: subscribePath(audience, 'unsubscribe'),
        body: { endpoint: sub.endpoint },
      })
      .catch(() => {});
    await sub.unsubscribe();
  }
  return pushState(await currentEnvironment());
}

export async function sendTestPush(
  audience: Audience,
): Promise<{ devices: number; sent: number; failed: number }> {
  return new ApiAction(api).run({ method: 'POST', path: subscribePath(audience, 'push-test') });
}
