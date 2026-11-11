import { Link, useSearchParams } from 'react-router';
import { ERROR_VARIANTS, type ErrorContext } from '../../lib/bids';
import { ErrorState } from './ErrorState';

/** Query-string fixture codes, one per W21 variant (the test plan's "each W21 via query string"). */
const FIXTURE_CODES = {
  window_closed: 'WINDOW_CLOSED',
  hold_failed: 'HOLD_FAILED',
  price_dropped: 'PRICE_DROP',
  declined: 'CAPTURE_FAILED',
  above_mandate: 'ABOVE_MANDATE_MAX',
  not_found: 'NOT_FOUND',
  session_expired: 'UNAUTHENTICATED',
  generic: 'INTERNAL_ERROR',
} as const;

/** Fixture amounts from the demo beat (features/06 §Logic 9). */
const FIXTURE_CONTEXT: ErrorContext = {
  amountCents: 22_900,
  offerSlug: 'aurel-a7-fixture',
  brandName: 'Aurel Audio',
  mandateMaxCents: 23_000,
  priceDrop: {
    newCents: 21_900,
    merchant: 'retailer.example',
    url: 'https://retailer.example/aurel-a7',
    released: true,
    replayed: false,
  },
};

/**
 * `/dev/states?code=PRICE_DROP` (HF-020 test plan): renders a W21 variant from its error code with
 * fixture amounts, no database needed. Without `code` it lists every variant. `&released=0` shows
 * a price-drop / window-closed hold still releasing.
 */
export function ErrorStatesFixture() {
  const [params] = useSearchParams();
  const code = params.get('code');
  const releasing = params.get('released') === '0';
  const ctx: ErrorContext = {
    ...FIXTURE_CONTEXT,
    holdReleased: params.has('released') ? !releasing : null,
    priceDrop: { ...FIXTURE_CONTEXT.priceDrop!, released: !releasing },
  };
  const codes = code ? [code] : ERROR_VARIANTS.map((v) => FIXTURE_CODES[v]);
  return (
    <div className="mx-auto flex max-w-[640px] flex-col gap-6 py-8">
      <p className="label text-[12px] text-muted">W21 fixture · demo data</p>
      <nav aria-label="Variants" className="flex flex-wrap gap-2">
        {ERROR_VARIANTS.map((v) => (
          <Link
            key={v}
            to={`?code=${FIXTURE_CODES[v]}`}
            className="label text-[11px] text-body underline"
          >
            {v}
          </Link>
        ))}
      </nav>
      {codes.map((c) => (
        <ErrorState key={c} code={c} context={ctx} />
      ))}
    </div>
  );
}
