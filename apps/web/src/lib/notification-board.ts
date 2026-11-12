import {
  BRAND_TEMPLATES,
  NOTIFICATION_SAMPLES,
  notificationPush,
  SHOPPER_TEMPLATES,
  type NotificationItem,
  type NotificationTemplate,
} from '@holdfast/shared';
import { toView, type Audience, type NotificationView } from './notifications';
import { paths } from './routes';

/**
 * M11 push / email notification set (HF-054b; screens.md §M11). Each card shows one notification
 * twice: as the phone's push preview and as the email. "Yours" is the very list behind the bell
 * (`GET /api/notifications`, rendered by the same `toView`), so the two never disagree; "All
 * templates" is every features/13 template on sample numbers.
 */

export interface BoardCard extends NotificationView {
  template: NotificationTemplate;
  /** Where tapping the push opens (M06 / M07 / M10 entry points). */
  pushUrl: string;
}

export function boardCards(items: NotificationItem[], now: number, timeZone?: string): BoardCard[] {
  const out: BoardCard[] = [];
  for (const item of items) {
    const view = toView(item, now, timeZone);
    if (!view) continue;
    const push = notificationPush(item.template, item.payload as never, item.id);
    out.push({ ...view, template: item.template, pushUrl: push.url });
  }
  return out;
}

export function templatesFor(audience: Audience): readonly NotificationTemplate[] {
  return audience === 'brand' ? BRAND_TEMPLATES : SHOPPER_TEMPLATES;
}

/** One card per template for `audience`, on the features/13 sample numbers (read, "Just now"). */
export function sampleCards(audience: Audience, now: number, timeZone?: string): BoardCard[] {
  const iso = new Date(now).toISOString();
  return boardCards(
    templatesFor(audience).map((template) => ({
      id: `sample-${template}`,
      template,
      payload: NOTIFICATION_SAMPLES[template] as unknown as Record<string, unknown>,
      createdAt: iso,
      readAt: iso,
    })),
    now,
    timeZone,
  );
}

export function boardPath(audience: Audience): string {
  return audience === 'brand' ? paths.brandNotifications : paths.notifications;
}
