import type { BrandMe } from './brand-gate';
import { DEMO_OFFER_SLUG, paths } from './routes';

/**
 * Who the app shell is drawn for (v4 §2.1, frames 109:21 / 109:40 / 109:59): a brand user, a buyer
 * (shopper session) or nobody (public nav). Decided from `GET /api/me`; pure so it is unit-tested.
 */
export type ViewerRole = 'brand' | 'buyer' | 'public';

/** The parts of `GET /api/me` the shell reads. */
export interface MeResponse {
  brandUser: BrandMe | null;
  shopper: {
    id: string;
    email: string | null;
    displayName?: string | null;
    provisional: boolean;
  } | null;
  demoMode?: boolean;
}

export interface Viewer {
  role: ViewerRole;
  /** Role chip text after the dot: brand name, buyer name. Null for the public nav. */
  name: string | null;
  isAdmin: boolean;
}

export const PUBLIC_VIEWER: Viewer = { role: 'public', name: null, isAdmin: false };

const BRAND_AREA = ['/brand', '/admin'];
const BUYER_AREA = ['/bids', '/o/', '/agent', '/mandates', '/notifications', '/settings'];

const inArea = (pathname: string, area: string[]) =>
  area.some((p) => pathname === p || pathname.startsWith(p.endsWith('/') ? p : `${p}/`));

/**
 * Someone can hold both sessions (a brand user who opened an offer page gets an anonymous shopper
 * cookie), so the page's area decides: brand pages show the brand nav, buyer pages the buyer nav.
 * Elsewhere a brand session wins, then a signed-in buyer, then an anonymous one with bids.
 */
export function viewerFor(me: MeResponse | null, pathname: string): Viewer {
  if (!me) return PUBLIC_VIEWER;
  const brand: Viewer | null = me.brandUser
    ? { role: 'brand', name: me.brandUser.brand.name, isAdmin: me.brandUser.isAdmin === true }
    : null;
  const buyer: Viewer | null = me.shopper
    ? { role: 'buyer', name: buyerName(me.shopper), isAdmin: false }
    : null;
  if (inArea(pathname, BRAND_AREA)) return brand ?? PUBLIC_VIEWER;
  if (inArea(pathname, BUYER_AREA)) return buyer ?? brand ?? PUBLIC_VIEWER;
  if (brand) return brand;
  if (buyer && !me.shopper?.provisional) return buyer;
  return PUBLIC_VIEWER;
}

/** "Maya R." from the PayPal display name; else the email's local part; else "Guest". */
export function buyerName(s: NonNullable<MeResponse['shopper']>): string {
  const name = s.displayName?.trim();
  if (name) return name;
  const local = s.email?.split('@')[0];
  return local || 'Guest';
}

export interface ShellAction {
  label: string;
  to: string;
  variant: 'primary' | 'secondary' | 'outline';
  /** Shortcut key shown in the button's chip (lib/shortcuts.ts). */
  shortcut: string;
}

/** Underline a top link on its own path and below it (`/bids/:id` keeps "My bids"). */
export function isLinkActive(pathname: string, activePrefix: string): boolean {
  return pathname === activePrefix || pathname.startsWith(`${activePrefix}/`);
}

export interface ShellNav {
  /** Where the logo goes: always the marketing home page, for every role. */
  home: string;
  links: { label: string; to: string; activePrefix: string }[];
  actions: ShellAction[];
}

/** Brand `Listings` target: Overview's list until the full My listings page lands. */
export const BRAND_LISTINGS_HREF = `${paths.brand}#listings`;

export function shellNav(role: ViewerRole): ShellNav {
  if (role === 'brand') {
    return {
      home: paths.home,
      links: [
        { label: 'My listings', to: BRAND_LISTINGS_HREF, activePrefix: '/brand/listings' },
        { label: 'Developer', to: paths.developer, activePrefix: paths.developer },
      ],
      actions: [
        { label: 'Settings', to: paths.brandSettings, variant: 'outline', shortcut: 'S' },
        { label: 'Payouts', to: paths.brandPayouts, variant: 'secondary', shortcut: 'P' },
      ],
    };
  }
  if (role === 'buyer') {
    return {
      home: paths.home,
      links: [
        { label: 'My bids', to: paths.bids, activePrefix: paths.bids },
        { label: 'Developer', to: paths.developer, activePrefix: paths.developer },
      ],
      actions: [
        {
          label: 'Place a bid',
          to: paths.offer(DEMO_OFFER_SLUG),
          variant: 'primary',
          shortcut: 'P',
        },
        { label: 'Settings', to: paths.settings, variant: 'outline', shortcut: 'S' },
      ],
    };
  }
  return { home: paths.home, links: [], actions: [] };
}
