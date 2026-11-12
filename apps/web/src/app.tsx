import { lazy, type ComponentType } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { AppShell } from './components/layout/AppShell';
import { BrandSectionLayout } from './components/layout/BrandSidebar';
import { ToastProvider } from './components/ui';
import { configReady } from './lib/client-config';
import { Landing } from './routes/Landing';
import { NotFound, RouteError, ScreenPlaceholder } from './routes/ScreenPlaceholder';

// Screens load on demand (HF-057): `/` ships only the landing page, not every screen and AG.
// AppShell wraps its outlet in Suspense; navigations are transitions, so the old screen stays up.
// `/` paints before the client config arrives, so a screen's module is only imported (and
// evaluated: AG registers its licence at import time) once the config has loaded.
function screen<K extends string, M extends Record<K, ComponentType>>(
  load: () => Promise<M>,
  name: K,
) {
  return lazy(() =>
    configReady()
      .then(load)
      .then((m) => ({ default: m[name] })),
  );
}
const AgentChatPage = screen(() => import('./routes/agent/AgentChatPage'), 'AgentChatPage');
const OpsPage = screen(() => import('./routes/admin/OpsPage'), 'OpsPage');
const BidDetailPage = screen(() => import('./routes/bids/BidDetailPage'), 'BidDetailPage');
const ErrorStatesFixture = screen(
  () => import('./routes/bids/ErrorStatesFixture'),
  'ErrorStatesFixture',
);
const MyBidsPage = screen(() => import('./routes/bids/MyBidsPage'), 'MyBidsPage');
const WonPage = screen(() => import('./routes/bids/WonPage'), 'WonPage');
const DemoHub = screen(() => import('./routes/DemoHub'), 'DemoHub');
const DeveloperPage = screen(() => import('./routes/Developer'), 'DeveloperPage');
const DevComponents = screen(() => import('./routes/DevComponents'), 'DevComponents');
const BrandGate = screen(() => import('./routes/brand/BrandGate'), 'BrandGate');
const BrandJoin = screen(() => import('./routes/brand/BrandJoin'), 'BrandJoin');
const BrandSettings = screen(() => import('./routes/brand/BrandSettings'), 'BrandSettings');
const BrandOverview = screen(() => import('./routes/brand/BrandOverview'), 'BrandOverview');
const BrandOnboarding = screen(() => import('./routes/brand/BrandOnboarding'), 'BrandOnboarding');
const BrandSignIn = screen(() => import('./routes/brand/BrandSignIn'), 'BrandSignIn');
const CreateListingWizard = screen(
  () => import('./routes/brand/CreateListingWizard'),
  'CreateListingWizard',
);
const EmbedPage = screen(() => import('./routes/brand/EmbedPage'), 'EmbedPage');
const PayoutsPage = screen(() => import('./routes/brand/PayoutsPage'), 'PayoutsPage');
const ListingConsole = screen(() => import('./routes/brand/ListingConsole'), 'ListingConsole');
const SettlementFixture = screen(
  () => import('./routes/brand/SettlementFixture'),
  'SettlementFixture',
);
const SettlementPage = screen(() => import('./routes/brand/SettlementPage'), 'SettlementPage');
const OfferPage = screen(() => import('./routes/offer/OfferPage'), 'OfferPage');
const MandateEditorPage = screen(() => import('./routes/Mandates'), 'MandateEditorPage');
const MandatesPage = screen(() => import('./routes/Mandates'), 'MandatesPage');
// M11 push / email set (HF-054b), one prop-less screen per audience.
const ShopperNotificationsBoard = screen(
  () => import('./routes/NotificationsBoard'),
  'ShopperNotificationsBoard',
);
const BrandNotificationsBoard = screen(
  () => import('./routes/NotificationsBoard'),
  'BrandNotificationsBoard',
);

/**
 * Route map (HF-007). Screens are filled in by later tickets; each placeholder names its ticket.
 * Brand: /brand/*. Shopper: /o/:slug, /bids/*, /agent, /mandates, /developer. Admin: /admin/*.
 * The API serves index.html for all of these (apps/api/src/web.ts), so reloads work.
 */
const router = createBrowserRouter([
  // W01 / M12 landing (HF-057): its own nav and footer, outside the app shell.
  { index: true, element: <Landing /> },
  {
    element: <AppShell />,
    // A lazy chunk that fails to load (stale tab after a redeploy) reloads once (HF-057).
    errorElement: <RouteError />,
    children: [
      // HF-007 demo hub, moved from `/` when the landing page shipped.
      { path: 'demo', element: <DemoHub /> },
      { path: 'dev/components', element: <DevComponents /> },
      // W21 error states from a query-string fixture (HF-020): /dev/states?code=PRICE_DROP
      { path: 'dev/states', element: <ErrorStatesFixture /> },
      // W08 on the recorded settlement event stream (HF-035): no sign-in or database needed.
      { path: 'dev/settlement', element: <SettlementFixture /> },
      // AG suppresses its licence watermark on localhost; any path containing "forceWatermark"
      // shows it as production would: /dev/components/forceWatermark is the local licence check.
      { path: 'dev/components/*', element: <DevComponents /> },

      // Brand
      // W02 (HF-010): Log in with PayPal, plus the DEMO_MODE sign-ins.
      { path: 'brand/sign-in', element: <BrandSignIn /> },
      // W03 (HF-011b): company, domain, payout; works from a pending PayPal identity.
      { path: 'brand/onboarding', element: <BrandOnboarding /> },
      // Invite link landing (HF-056): sign in with PayPal, then join the brand.
      { path: 'brand/join', element: <BrandJoin /> },
      {
        // HF-023: brand session + listings. `/brand` is the W04 overview (HF-026).
        element: <BrandGate />,
        children: [
          {
            // v4 §2.1: section pages share the left sidebar; drill-in pages below have none.
            element: <BrandSectionLayout />,
            children: [
              { path: 'brand', element: <BrandOverview /> },
              // W09 payouts, statements and tracking upload (HF-059b).
              { path: 'brand/payouts', element: <PayoutsPage /> },
              // W10 embed widget & share links (HF-055).
              { path: 'brand/embed', element: <EmbedPage /> },
              // W11 brand settings (HF-056): team, payout, verification, retailers, notifications.
              { path: 'brand/settings', element: <BrandSettings /> },
              // M11 push / email set for brand users (HF-054b).
              { path: 'brand/notifications', element: <BrandNotificationsBoard /> },
            ],
          },
          // W05 create listing wizard (HF-013); before `:listingId` so "new" is not an id.
          { path: 'brand/listings/new', element: <CreateListingWizard /> },
          { path: 'brand/listings/:listingId', element: <ListingConsole /> },
          // W08 settlement live view (HF-035).
          { path: 'brand/listings/:listingId/settlement', element: <SettlementPage /> },
        ],
      },
      {
        path: 'brand/*',
        element: <ScreenPlaceholder screen="Brand console" ticket="a later brand ticket" />,
      },

      // Shopper
      {
        path: 'o/:slug',
        element: <OfferPage />,
      },
      // W14 / M03 my bids; W15 / M04 timeline, also W13 / M02 (?held=1) and W21 (?error=CODE).
      { path: 'bids', element: <MyBidsPage /> },
      { path: 'bids/:bidId', element: <BidDetailPage /> },
      // W18 / M08 won page: receipt and shipping progress (HF-059a).
      { path: 'bids/:bidId/won', element: <WonPage /> },
      // W16 / M05 buyer agent chat (HF-041); `?fixture=1` replays a recorded turn.
      { path: 'agent', element: <AgentChatPage /> },
      // M11 push / email notification set + phone alerts switch (HF-054b).
      { path: 'notifications', element: <ShopperNotificationsBoard /> },
      { path: 'mandates', element: <MandatesPage /> },
      { path: 'mandates/new', element: <MandateEditorPage /> },
      { path: 'mandates/:mandateId', element: <MandateEditorPage /> },
      // W19 Developer / MCP connect (HF-043): tokens, Claude Desktop config, readiness.
      { path: 'developer', element: <DeveloperPage /> },

      // Admin: W20 ops / audit log (HF-058), `ADMIN_EMAILS` only.
      { path: 'admin', element: <OpsPage /> },
      { path: 'admin/*', element: <OpsPage /> },

      { path: '*', element: <NotFound /> },
    ],
  },
]);

export function App() {
  return (
    <ToastProvider>
      <RouterProvider router={router} />
    </ToastProvider>
  );
}
