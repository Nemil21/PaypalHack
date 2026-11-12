import { describe, expect, it } from 'vitest';
import type { NotificationItem, NotificationsResponse } from '@holdfast/shared';
import {
  badgeText,
  bellLabel,
  markAllReadLocally,
  markReadLocally,
  notificationsQuery,
  relativeTime,
  toView,
} from './notifications';

const NOW = Date.parse('2026-11-12T12:00:00Z');
const item = (over: Partial<NotificationItem> = {}): NotificationItem => ({
  id: 'n1',
  template: 'won',
  payload: { bidId: 'b1', listingId: 'l1', amountCents: 22_900 },
  createdAt: '2026-11-12T11:55:00Z',
  readAt: null,
  ...over,
});

describe('notification bell helpers (HF-054a)', () => {
  it('renders an item with the shared D14 copy and an in-app link', () => {
    expect(toView(item(), NOW)).toMatchObject({
      id: 'n1',
      title: 'You won',
      body: 'You won at your bid of $229. Charged $229.',
      link: { href: '/bids/b1/won', label: 'View receipt & tracking' },
      unread: true,
      when: '5 min ago',
      external: false,
    });
  });

  it('a price-drop buy link is external and carries the affiliate disclosure', () => {
    const v = toView(
      item({
        template: 'price_drop_released',
        payload: {
          bidId: 'b1',
          listingId: 'l1',
          amountCents: 24_900,
          publicPriceCents: 24_500,
          merchant: null,
          url: 'https://store.example/p',
        },
      }),
      NOW,
    )!;
    expect(v.external).toBe(true);
    expect(v.disclosure).toMatch(/commission/);
  });

  it('skips unknown templates and malformed payloads', () => {
    expect(toView(item({ template: 'nope' as never }), NOW)).toBeNull();
    expect(toView(item({ template: 'brand_cleared', payload: {} }), NOW)).toBeNull();
  });

  it('unread badge, label, relative time and query', () => {
    expect(badgeText(0)).toBeNull();
    expect(badgeText(3)).toBe('3');
    expect(badgeText(12)).toBe('9+');
    expect(bellLabel(2)).toBe('Notifications, 2 unread');
    expect(relativeTime('2026-11-12T11:59:30Z', NOW)).toBe('Just now');
    expect(relativeTime('2026-11-12T09:00:00Z', NOW)).toBe('3 h ago');
    expect(relativeTime('2026-11-10T12:00:00Z', NOW)).toBe('2 d ago');
    expect(notificationsQuery('brand')).toBe('?as=brand');
    expect(notificationsQuery('shopper')).toBe('');
  });

  it('mark-as-read updates the list and the unread count', () => {
    const state: NotificationsResponse = {
      notifications: [
        item(),
        item({ id: 'n2' }),
        item({ id: 'n3', readAt: '2026-11-12T10:00:00Z' }),
      ],
      unreadCount: 2,
    };
    const one = markReadLocally(state, 'n1', '2026-11-12T12:00:00Z');
    expect(one.unreadCount).toBe(1);
    expect(one.notifications[0]!.readAt).toBe('2026-11-12T12:00:00Z');
    // Already read: no double decrement; the server's count wins when known.
    expect(markReadLocally(one, 'n1', 'x').unreadCount).toBe(1);
    expect(markReadLocally(state, 'n1', 'x', 7).unreadCount).toBe(7);
    const all = markAllReadLocally(state, 'z');
    expect(all.unreadCount).toBe(0);
    expect(all.notifications.every((n) => n.readAt)).toBe(true);
    expect(all.notifications[2]!.readAt).toBe('2026-11-12T10:00:00Z');
  });
});
