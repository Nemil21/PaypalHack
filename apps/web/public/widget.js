/*! Holdfast "Make an offer" button (HF-055, features/14). No dependencies; keep under 10 KB.
 *
 *   <script src="https://<app>/widget.js" data-listing="aurel-a7" data-theme="light"
 *           data-source="widget" async></script>
 *
 * data-listing  offer slug (required)
 * data-theme    light | dark (default light)
 * data-source   utm_source for attribution (default "widget")
 * data-label    button text (default "Make an offer")
 *
 * The button opens /o/<slug> in a new tab, never an iframe: PayPal approval can't be framed and
 * the SameSite=Lax shopper cookie isn't sent cross-site, so sign-in and holds need a first-party
 * tab. It checks the listing once on load and shows "Offers closed" when new bids aren't taken.
 * Colours are CSS variables on the host element, e.g. `.hf-offer { --hf-accent: #0b5 }`.
 */
(function () {
  'use strict';
  var script = document.currentScript;
  if (!script || script.getAttribute('data-hf-done')) return;
  script.setAttribute('data-hf-done', '1');

  var slug = script.getAttribute('data-listing');
  if (!slug) return;
  var origin = new URL(script.src, location.href).origin;
  var dark = script.getAttribute('data-theme') === 'dark';
  var source = (script.getAttribute('data-source') || 'widget').toLowerCase();
  if (!/^[a-z0-9_-]{1,32}$/.test(source)) source = 'widget';
  var label = script.getAttribute('data-label') || 'Make an offer';

  var href =
    origin +
    '/o/' +
    encodeURIComponent(slug) +
    '?utm_source=' +
    encodeURIComponent(source) +
    '&utm_medium=widget';

  var host = document.createElement('span');
  host.className = 'hf-offer';
  host.setAttribute('data-theme', dark ? 'dark' : 'light');
  script.parentNode.insertBefore(host, script);
  var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;

  var style = document.createElement('style');
  style.textContent =
    ':host{display:inline-block;' +
    (dark
      ? '--hf-bg:#f5f5f2;--hf-fg:#111;--hf-border:#f5f5f2;--hf-muted:#a3a39b;'
      : '--hf-bg:#111;--hf-fg:#fff;--hf-border:#111;--hf-muted:#6b6b63;') +
    '}' +
    '.b{display:inline-flex;align-items:center;gap:8px;box-sizing:border-box;min-height:44px;' +
    'padding:0 20px;border:1px solid var(--hf-accent,var(--hf-border));border-radius:6px;' +
    'background:var(--hf-accent,var(--hf-bg));color:var(--hf-fg);text-decoration:none;' +
    'font:600 15px/1 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;cursor:pointer}' +
    '.b:hover{filter:brightness(1.12)}' +
    '.b:focus-visible{outline:2px solid var(--hf-accent,var(--hf-border));outline-offset:2px}' +
    '.b[aria-disabled=true]{background:transparent;color:var(--hf-muted);' +
    'border-color:var(--hf-muted);cursor:not-allowed;filter:none}' +
    '.n{display:block;margin-top:6px;font:12px/1.3 ui-sans-serif,system-ui,sans-serif;' +
    'color:var(--hf-muted)}';
  root.appendChild(style);

  var a = document.createElement('a');
  a.className = 'b';
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener';
  a.setAttribute('part', 'button');
  a.textContent = label;
  root.appendChild(a);

  var note = document.createElement('span');
  note.className = 'n';
  note.setAttribute('part', 'note');
  note.textContent = 'Name your price. Held with PayPal, not charged unless it clears.';
  root.appendChild(note);

  function close() {
    a.removeAttribute('href');
    a.removeAttribute('target');
    a.setAttribute('role', 'link');
    a.setAttribute('aria-disabled', 'true');
    a.textContent = 'Offers closed';
    note.textContent = 'This offer window has ended.';
    host.setAttribute('data-state', 'closed');
  }

  // One status check on load. If it fails, keep the button: the offer page shows the real state.
  fetch(origin + '/api/widget/' + encodeURIComponent(slug), { credentials: 'omit' })
    .then(function (r) {
      if (r.status === 404) return { biddable: false };
      return r.ok ? r.json() : null;
    })
    .then(function (s) {
      if (s && s.biddable === false) close();
      else host.setAttribute('data-state', 'open');
    })
    .catch(function () {
      host.setAttribute('data-state', 'open');
    });
})();
