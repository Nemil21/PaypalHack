import { buyerName, type MeResponse } from './viewer';

/**
 * Buyer settings view model (v4 §2.3, frame 115:303). Pure so the states and copy are tested.
 * Name and shipping address are read-only (decision 5): there is no profile API, they come from
 * PayPal. Notifications have no per-type switches in the API, so the events are listed as always
 * on, next to the real "Phone alerts" switch.
 */
export type BuyerSettingsState = 'signed-out' | 'guest' | 'signed-in';

export function buyerSettingsState(me: MeResponse | null): BuyerSettingsState {
  if (!me?.shopper) return 'signed-out';
  return me.shopper.provisional ? 'guest' : 'signed-in';
}

export const READ_ONLY_NOTE =
  "Name and address come from your PayPal account and can't be edited here yet.";

export interface PayPalRow {
  title: string;
  detail: string;
  badge: { label: string; tone: 'success' | 'neutral' } | null;
}

/** The PayPal card's first row: the saved PayPal method, if a hold already vaulted one. */
export function paypalRow(savedPaymentMethod: boolean | null): PayPalRow {
  if (savedPaymentMethod === null) return { title: 'PayPal', detail: 'Checking…', badge: null };
  return savedPaymentMethod
    ? {
        title: 'PayPal',
        detail: 'Saved. Your agent can place holds on it within your mandates.',
        badge: { label: 'Connected', tone: 'success' },
      }
    : {
        title: 'PayPal',
        detail: 'You approve each hold with PayPal. Nothing is saved yet.',
        badge: { label: 'Not saved', tone: 'neutral' },
      };
}

export interface ProfileView {
  name: string;
  email: string | null;
}

export function profileView(me: MeResponse): ProfileView {
  return { name: me.shopper ? buyerName(me.shopper) : 'Guest', email: me.shopper?.email ?? null };
}

/** What a buyer is told about (shared SHOPPER_TEMPLATES, grouped). All always on. */
export const BUYER_NOTIFICATION_EVENTS: ReadonlyArray<string> = [
  'Hold placed on a bid',
  'Below the cutoff, or a round opens on my bid',
  'Won, then shipped with tracking',
  'Hold released',
];
