import { createBrowserRouter, RouterProvider } from 'react-router';
import { AppShell } from './components/layout/AppShell';
import { ToastProvider } from './components/ui';
import { DemoHub } from './routes/DemoHub';
import { DevComponents } from './routes/DevComponents';
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
      // AG suppresses its licence watermark on localhost; any path containing "forceWatermark"
      // shows it as production would: /dev/components/forceWatermark is the local licence check.
      { path: 'dev/components/*', element: <DevComponents /> },

      // Brand
      {
        path: 'brand/sign-in',
        element: <ScreenPlaceholder screen="Brand sign-in (W02)" ticket="HF-006 / HF-010" />,
      },
      {
        path: 'brand/onboarding',
        element: <ScreenPlaceholder screen="Brand verification (W03)" ticket="HF-011b" />,
      },
      {
        path: 'brand',
        element: <ScreenPlaceholder screen="Brand overview (W04)" ticket="HF-026" />,
      },
      {
        path: 'brand/listings/new',
        element: <ScreenPlaceholder screen="Create listing (W05)" ticket="HF-013" />,
      },
      {
        path: 'brand/listings/:listingId',
        element: <ScreenPlaceholder screen="Listing console (W06)" ticket="HF-023" />,
      },
      {
        path: 'brand/listings/:listingId/settlement',
        element: <ScreenPlaceholder screen="Settlement (W08)" ticket="HF-035" />,
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
      { path: 'bids', element: <ScreenPlaceholder screen="My bids (W14 / M03)" ticket="HF-020" /> },
      {
        path: 'bids/:bidId',
        element: <ScreenPlaceholder screen="Bid timeline (W15 / M04)" ticket="HF-020" />,
      },
      { path: 'bids/*', element: <ScreenPlaceholder screen="My bids" ticket="HF-020" /> },
      {
        path: 'agent',
        element: <ScreenPlaceholder screen="Buyer agent (W16 / M05)" ticket="HF-041" />,
      },
      { path: 'mandates', element: <MandatesPage /> },
      { path: 'mandates/new', element: <MandateEditorPage /> },
      { path: 'mandates/:mandateId', element: <MandateEditorPage /> },
      {
        path: 'developer',
        element: <ScreenPlaceholder screen="Developer / MCP (W19)" ticket="HF-043" />,
      },

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
