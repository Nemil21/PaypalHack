import { createBrowserRouter, RouterProvider } from 'react-router';
import { AppShell } from './components/layout/AppShell';
import { AgentChatPage } from './routes/agent/AgentChatPage';
import { ToastProvider } from './components/ui';
import { BidDetailPage } from './routes/bids/BidDetailPage';
import { ErrorStatesFixture } from './routes/bids/ErrorStatesFixture';
import { MyBidsPage } from './routes/bids/MyBidsPage';
import { DemoHub } from './routes/DemoHub';
import { DeveloperPage } from './routes/Developer';
import { DevComponents } from './routes/DevComponents';
import { BrandGate } from './routes/brand/BrandGate';
import { BrandOverview } from './routes/brand/BrandOverview';
import { BrandOnboarding } from './routes/brand/BrandOnboarding';
import { BrandSignIn } from './routes/brand/BrandSignIn';
import { CreateListingWizard } from './routes/brand/CreateListingWizard';
import { EmbedPage } from './routes/brand/EmbedPage';
import { ListingConsole } from './routes/brand/ListingConsole';
import { SettlementFixture } from './routes/brand/SettlementFixture';
import { SettlementPage } from './routes/brand/SettlementPage';
import { OfferPage } from './routes/offer/OfferPage';
import { MandateEditorPage, MandatesPage } from './routes/Mandates';
import { NotFound, ScreenPlaceholder } from './routes/ScreenPlaceholder';

/**
 * Route map (HF-007). Screens are filled in by later tickets; each placeholder names its ticket.
 * Brand: /brand/*. Shopper: /o/:slug, /bids/*, /agent, /mandates, /developer. Admin: /admin/*.
 * The API serves index.html for all of these (apps/api/src/web.ts), so reloads work.
 */
const router = createBrowserRouter([
  {
    element: <AppShell />,
    children: [
      { index: true, element: <DemoHub /> },
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
      {
        // HF-023: brand session + listings. `/brand` is the W04 overview (HF-026).
        element: <BrandGate />,
        children: [
          { path: 'brand', element: <BrandOverview /> },
          // W05 create listing wizard (HF-013); before `:listingId` so "new" is not an id.
          { path: 'brand/listings/new', element: <CreateListingWizard /> },
          { path: 'brand/listings/:listingId', element: <ListingConsole /> },
          // W08 settlement live view (HF-035).
          { path: 'brand/listings/:listingId/settlement', element: <SettlementPage /> },
          // W10 embed widget & share links (HF-055).
          { path: 'brand/embed', element: <EmbedPage /> },
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
      // W16 / M05 buyer agent chat (HF-041); `?fixture=1` replays a recorded turn.
      { path: 'agent', element: <AgentChatPage /> },
      { path: 'mandates', element: <MandatesPage /> },
      { path: 'mandates/new', element: <MandateEditorPage /> },
      { path: 'mandates/:mandateId', element: <MandateEditorPage /> },
      // W19 Developer / MCP connect (HF-043): tokens, Claude Desktop config, readiness.
      { path: 'developer', element: <DeveloperPage /> },

      // Admin
      {
        path: 'admin/*',
        element: <ScreenPlaceholder screen="Ops / audit (W20)" ticket="HF-058" />,
      },

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
