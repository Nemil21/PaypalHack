/* Holdfast service worker (HF-054b; features/13 §Channels, screens.md M06 / M07 / M10).
 *
 * Push only: no offline cache, so a deploy never serves a stale app. The server sends
 * `{ title, body, url, tag, template }` (packages/shared `notificationPush`); a tap focuses an
 * open Holdfast tab and navigates it to `url` (the M06 / M07 sheet, M10), or opens a new one.
 * Served from the site root so its scope is the whole app; `Cache-Control: no-cache` (web.ts).
 */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'Holdfast';
  // Same-origin paths only: a payload can never send the tap somewhere else.
  const url =
    typeof data.url === 'string' && data.url.startsWith('/') && !data.url.startsWith('//')
      ? data.url
      : '/notifications';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      tag: data.tag || undefined,
      renotify: Boolean(data.tag),
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/notifications', self.location.origin);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin !== target.origin) continue;
        await client.focus();
        if ('navigate' in client) return client.navigate(target.href);
        return undefined;
      }
      return self.clients.openWindow(target.href);
    })(),
  );
});
