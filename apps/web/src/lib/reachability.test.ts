import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { paths } from './routes.js';

/**
 * v4 done checklist (§7): every route in `paths` can be reached by clicking, per the Reachability
 * map (Figma 122:820). Each key names the source files whose links reach it; the test checks those
 * files still reference the path (`paths.<key>` or its literal). `/dev/*` must stay unlinked.
 * A route that is not listed yet, or whose entry point another v4 stream is still building, shows
 * up as a todo instead of failing, so a parallel PR adding a route can't turn main red.
 */
type Entry =
  | { from: string[]; literal?: string }
  /** Reached from outside the app (an email link, a redirect). */
  | { external: string }
  /** The designed entry point is not built yet; who owns it. */
  | { pending: string }
  | { dev: true };

const MAP: Partial<Record<keyof typeof paths, Entry>> = {
  home: { from: ['components/layout/AppShell.tsx'] },
  demo: { from: ['routes/Landing.tsx'] },
  signIn: { pending: 'Landing nav "Sign in" (v4 §1, landing stream)' },
  buyerSignIn: { from: ['lib/sign-in.ts'] },
  brandSignIn: { from: ['routes/brand/BrandGate.tsx'] },
  brandOnboarding: { from: ['routes/brand/BrandGate.tsx', 'routes/brand/BrandSignIn.tsx'] },
  brand: { from: ['lib/viewer.ts', 'lib/brand-overview.ts'] },
  newListing: { from: ['components/layout/BrandSidebar.tsx'] },
  brandPayouts: { from: ['lib/viewer.ts'] },
  brandEmbed: { from: ['lib/brand-overview.ts'] },
  brandSettings: { from: ['lib/viewer.ts'] },
  brandJoin: { external: 'the invite email link (`/brand/join#hfi_…`)' },
  listingConsole: { from: ['lib/brand-overview.ts'] },
  listingSettlement: { from: ['routes/brand/ListingConsole.tsx', 'routes/brand/PayoutsPage.tsx'] },
  offer: { from: ['lib/viewer.ts'] },
  bids: { from: ['lib/viewer.ts'] },
  bidWon: { from: ['routes/bids/BidDetailPage.tsx'] },
  agent: { pending: 'My bids rail "Chat with your agent" (v4 §2.3, buyer screens)' },
  mandates: { from: ['lib/bids.ts'], literal: "'/mandates'" },
  newMandate: { from: ['routes/Developer.tsx'] },
  mandate: { from: ['routes/Developer.tsx'] },
  developer: { from: ['lib/viewer.ts'] },
  settings: { from: ['lib/viewer.ts'] },
  notifications: { from: ['lib/notification-board.ts'] },
  brandNotifications: { from: ['lib/notification-board.ts'] },
  admin: { pending: 'Brand Settings › Account › "Ops console" for admins (v4 §2.2)' },
  devComponents: { dev: true },
};

const src = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

describe('reachability map (122:820)', () => {
  for (const key of Object.keys(paths) as (keyof typeof paths)[]) {
    const entry = MAP[key];
    if (!entry) {
      it.todo(`${key}: add it to the reachability map in lib/reachability.test.ts`);
      continue;
    }
    if ('pending' in entry) {
      it.todo(`${key}: entry point not built yet: ${entry.pending}`);
      continue;
    }
    if ('external' in entry || 'dev' in entry) continue;
    it(`${key} is linked from ${entry.from.join(', ')}`, () => {
      for (const file of entry.from) {
        const text = src(file);
        const linked =
          new RegExp(`paths\\.${key}\\b`).test(text) ||
          (entry.literal !== undefined && text.includes(entry.literal));
        expect(linked, `${file} should link to paths.${key}`).toBe(true);
      }
    });
  }

  it('/dev/* stays unlinked: only the route table and the dev screens mention it', () => {
    for (const file of ['components/layout/AppShell.tsx', 'lib/viewer.ts', 'routes/Landing.tsx']) {
      expect(src(file)).not.toMatch(/paths\.devComponents|['"`]\/dev\//);
    }
  });
});
