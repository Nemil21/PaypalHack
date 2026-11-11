import { describe, expect, it } from 'vitest';
import {
  BRAND_TEMPLATES,
  NOTIFICATION_SAMPLES,
  SHOPPER_TEMPLATES,
  type NotificationItem,
} from '@holdfast/shared';
import { boardCards, boardPath, sampleCards } from './notification-board';
import { toView } from './notifications';

const now = Date.parse('2026-11-12T12:00:00Z');
const item = (
  over: Partial<NotificationItem> & Pick<NotificationItem, 'template'>,
): NotificationItem => ({
  id: crypto.randomUUID(),
  payload: NOTIFICATION_SAMPLES[over.template] as unknown as Record<string, unknown>,
  createdAt: '2026-11-12T11:00:00Z',
  readAt: null,
  ...over,
});

describe('HF-054b M11 board', () => {
  it('lists the same items as the bell, in the same order and words', () => {
    const items = [
      item({ template: 'price_drop_released' }),
      item({ template: 'won', readAt: '2026-11-12T11:30:00Z' }),
      item({ template: 'lost' }),
      { ...item({ template: 'won' }), template: 'from_a_newer_build' as never },
    ];
    const bell = items.map((i) => toView(i, now)).filter((v) => v !== null);
    const board = boardCards(items, now);
    expect(board.map((c) => c.id)).toEqual(bell.map((v) => v!.id));
    expect(board.map((c) => [c.title, c.body, c.unread])).toEqual(
      bell.map((v) => [v!.title, v!.body, v!.unread]),
    );
  });

  it('push previews deep-link to the M06 / M07 sheets', () => {
    const [drop, below] = boardCards(
      [item({ template: 'price_drop_released' }), item({ template: 'below_clearing' })],
      now,
    );
    expect(drop!.pushUrl).toMatch(/\?sheet=drop$/);
    expect(below!.pushUrl).toMatch(/\?sheet=raise&around=\d+$/);
  });

  it('the template set covers every features/13 template per audience', () => {
    expect(sampleCards('shopper', now).map((c) => c.template)).toEqual([...SHOPPER_TEMPLATES]);
    expect(sampleCards('brand', now).map((c) => c.template)).toEqual([...BRAND_TEMPLATES]);
    expect(sampleCards('shopper', now).find((c) => c.template === 'won')!.body).toBe(
      'You won at your bid of $229. Charged $229.',
    );
  });

  it('board paths', () => {
    expect(boardPath('shopper')).toBe('/notifications');
    expect(boardPath('brand')).toBe('/brand/notifications');
  });
});
