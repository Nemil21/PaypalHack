import { describe, expect, it } from 'vitest';
import { AFFILIATE_DISCLOSURE, BANK_PENDING_NOTE } from './copy.js';
import {
  escapeHtml,
  NOTIFICATION_SAMPLES,
  notificationEmail,
  notificationPush,
  pushUrl,
} from './notification-channels.js';
import {
  NOTIFICATION_TEMPLATES,
  renderNotification,
  UNIFORM_PRICE_PATTERNS,
  type NotificationTemplate,
} from './notifications.js';

const BASE = 'https://holdfast.example';
const sample = <T extends NotificationTemplate>(t: T) => NOTIFICATION_SAMPLES[t];

describe('HF-054b email rendering', () => {
  it('won renders the D14 pay-your-bid copy', () => {
    const m = notificationEmail('won', sample('won'), { baseUrl: BASE });
    expect(m.subject).toBe('You won');
    expect(m.text).toContain('You won at your bid of $229. Charged $229.');
    expect(m.html).toContain('You won at your bid of $229. Charged $229.');
    expect(m.text).toContain(`View bid: ${BASE}/bids/${sample('won').bidId}`);
    expect(m.html).toContain(`href="${BASE}/bids/${sample('won').bidId}"`);
  });

  it('every release adds the bank-pending note (D14)', () => {
    for (const t of ['lost', 'price_drop_released'] as const) {
      expect(notificationEmail(t, sample(t)).text).toContain(BANK_PENDING_NOTE);
    }
  });

  it('a price drop carries the retailer link and the affiliate disclosure', () => {
    const m = notificationEmail('price_drop_released', sample('price_drop_released'), {
      baseUrl: BASE,
    });
    expect(m.text).toContain('Buy there →: https://example.com/buy');
    expect(m.text).toContain(AFFILIATE_DISCLOSURE);
    expect(m.html).toContain(escapeHtml(AFFILIATE_DISCLOSURE));
  });

  it('email body is the in-app body for every template, with no uniform-price wording', () => {
    for (const t of NOTIFICATION_TEMPLATES) {
      const m = notificationEmail(t, sample(t) as never, { baseUrl: BASE });
      const r = renderNotification(t, sample(t) as never);
      expect(m.subject).toBe(r.title);
      expect(m.text.startsWith(r.body)).toBe(true);
      for (const re of UNIFORM_PRICE_PATTERNS) expect(m.text).not.toMatch(re);
    }
  });

  it('escapes HTML from payload strings', () => {
    const m = notificationEmail('bid_rolled', { ...sample('bid_rolled'), brandName: '<b>X</b>' });
    expect(m.html).not.toContain('<b>X</b>');
    expect(m.html).toContain('&lt;b&gt;X&lt;/b&gt;');
  });

  it('keeps relative links without a base URL', () => {
    expect(notificationEmail('won', sample('won')).text).toContain('View bid: /bids/');
  });
});

describe('HF-054b push payloads', () => {
  it('price_drop_released opens the M06 sheet, not the retailer', () => {
    const p = notificationPush('price_drop_released', sample('price_drop_released'), 'k');
    expect(p.url).toBe(`/bids/${sample('price_drop_released').bidId}?sheet=drop`);
    expect(p.body).toContain(BANK_PENDING_NOTE);
    expect(p.tag).toBe('k');
  });

  it('raise prompts open M07; brand closing opens the listing (M10)', () => {
    expect(pushUrl('below_clearing', sample('below_clearing'))).toMatch(
      /\?sheet=raise&around=21900$/,
    );
    expect(pushUrl('round_nudge', sample('round_nudge'))).toMatch(/\?sheet=raise$/);
    expect(pushUrl('brand_window_closing', sample('brand_window_closing'))).toBe(
      `/brand/listings/${sample('brand_window_closing').listingId}`,
    );
  });

  it('every template has a same-origin tap target and stays small', () => {
    for (const t of NOTIFICATION_TEMPLATES) {
      const p = notificationPush(t, sample(t) as never, `${t}:x`);
      expect(p.url.startsWith('/')).toBe(true);
      expect(JSON.stringify(p).length).toBeLessThan(2000);
    }
  });
});
