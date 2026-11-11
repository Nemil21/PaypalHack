import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { formatUsd } from '@holdfast/shared';
import { Badge, Button, ErrorBanner, MoneySkeleton, Skeleton } from '../../components/ui';
import { ApiAction, ApiError, api } from '../../lib/api';
import { cn } from '../../lib/cn';
import { clientConfig } from '../../lib/client-config';
import {
  anchorText,
  countdownText,
  holdFailure,
  holdLabel,
  initialAmount,
  NO_RELEASE_COPY,
  offerMode,
  overPublicWarning,
  parseAmountParam,
  parseSourceParam,
  priceHint,
  sliderRange,
  type OfferPaymentMethod,
  type OfferView,
} from '../../lib/offer';
import { CardHold } from '../../lib/card-hold';
import type { CardFieldsSession } from '../../lib/paypal-sdk';
import { PriceWatchPausedBanner } from '../../components/PriceWatchPausedBanner';
import { NotFound } from '../ScreenPlaceholder';
import { CardFields } from './CardFields';
import { MyBidPanel } from './MyBidPanel';
import { Faq, HowItWorks, TrustRow } from './OfferInfo';
import { PriceInput } from './PriceInput';
import { ShopperIdentity } from './ShopperIdentity';

/** `POST /api/bids` answer (api.md): HELD for TEST_CARD, `approveUrl` for PAYPAL, `orderId` for CARD. */
interface PlaceBidResponse {
  bidId: string;
  status: string;
  amountCents: number;
  approveUrl?: string;
  orderId?: string;
}

type Load =
  | { state: 'loading' }
  | { state: 'missing' }
  | { state: 'error'; message: string }
  | { state: 'ready'; offer: OfferView };

/**
 * W12 / M01 shopper offer page (HF-019; features/03 §Logic 1–4). Payment, in build order:
 *   Part 1: the labelled "Use sandbox test card" button (`TEST_CARD`, server-side S1 hold).
 *   Part 2: PayPal wallet (redirect to `approveUrl`) and JS SDK v6 card fields
 *           (`POST /bids` CARD → `submit(orderId)` → `POST /bids/:id/authorize`), both HF-014b.
 * One Idempotency-Key per attempt (`ApiAction`): reused on a retry of the same request, new after
 * a terminal failure or when the amount or payment method changes. Double clicks are blocked
 * locally and, if one slips through, deduped by the shared key.
 */
export function OfferPage() {
  const { slug = '' } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const cfg = clientConfig();
  const amountParam = parseAmountParam(params.get('amount'));
  const utmSource = parseSourceParam(params.get('src'));

  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [amount, setAmount] = useState<number | null>(null);
  const [method, setMethod] = useState<Exclude<OfferPaymentMethod, 'TEST_CARD'>>('PAYPAL');
  const [overConfirmed, setOverConfirmed] = useState(false);
  const [warningFor, setWarningFor] = useState<OfferPaymentMethod | null>(null);
  const [busy, setBusy] = useState<OfferPaymentMethod | null>(null);
  const [failure, setFailure] = useState<{ text: string; retry?: OfferPaymentMethod } | null>(null);
  const [cardSession, setCardSession] = useState<CardFieldsSession | null>(null);
  /** The half-done card bid, if any: retries continue it (see lib/card-hold.ts). */
  const cardHold = useRef(new CardHold());
  const inFlight = useRef(false);
  const bidAction = useRef(new ApiAction(api));
  const authorizeAction = useRef(new ApiAction(api));

  const fetchOffer = useCallback(async () => {
    try {
      const offer = await api.request<OfferView>({
        method: 'GET',
        path: `/api/offers/${encodeURIComponent(slug)}`,
      });
      setLoad({ state: 'ready', offer });
      setAmount((a) => a ?? initialAmount(offer, amountParam));
      return offer;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setLoad({ state: 'missing' });
      else
        setLoad({
          state: 'error',
          message: err instanceof ApiError ? err.message : 'We could not load this offer.',
        });
      return null;
    }
  }, [slug, amountParam]);

  useEffect(() => {
    void fetchOffer();
  }, [fetchOffer]);

  const offer = load.state === 'ready' ? load.offer : null;
  const deadline = offer?.biddable
    ? offer.windowClosesAt
    : offer?.status === 'ROUNDS'
      ? offer.roundsEndAt
      : null;
  const msLeft = useCountdown(deadline, () => void fetchOffer());

  if (load.state === 'missing') return <NotFound />;
  if (load.state === 'error') {
    return (
      <div className="py-12">
        <ErrorBanner message={load.message} onRetry={() => void fetchOffer()} />
      </div>
    );
  }
  if (!offer || amount === null) return <OfferSkeleton />;

  const mode = offerMode(offer);
  const warning = overPublicWarning(amount, offer.publicOffer);
  const cardAvailable = !!cfg.paypalClientId;

  const changeAmount = (cents: number) => {
    setAmount(cents);
    setOverConfirmed(false);
    setWarningFor(null);
    setFailure(null);
  };

  const hold = async (pay: OfferPaymentMethod, confirmedOver = overConfirmed) => {
    if (inFlight.current) return; // double click: one attempt at a time
    if (warning && !confirmedOver) {
      setWarningFor(pay);
      return;
    }
    if (pay === 'CARD' && !cardSession) {
      setFailure({ text: 'The card fields are still loading. Try again in a moment.' });
      return;
    }
    inFlight.current = true;
    setBusy(pay);
    setFailure(null);
    setWarningFor(null);
    const cancelBid = (bidId: string) =>
      api.request({ method: 'POST', path: `/api/bids/${bidId}/cancel` }, crypto.randomUUID());
    const placeBid = async () => {
      const placed = await bidAction.current.run<PlaceBidResponse>({
        method: 'POST',
        path: '/api/bids',
        body: {
          listingId: offer.listingId,
          amountCents: amount,
          paymentMethod: pay,
          releaseIfCheaper: !(warning && confirmedOver),
          ...(utmSource ? { utmSource } : {}),
        },
      });
      // The bid exists: its key is spent. Continuing it (card submit / authorize) needs no new
      // POST /bids, and the next one, if any, is a new attempt with a new key.
      bidAction.current.reset();
      return placed;
    };
    try {
      if (pay === 'CARD') {
        const session = cardSession!;
        const out = await cardHold.current.run(amount, {
          placeBid,
          submit: (orderId) => session.submit(orderId, { billingAddress: { countryCode: 'US' } }),
          authorize: (bidId) =>
            authorizeAction.current.run<PlaceBidResponse>({
              method: 'POST',
              path: `/api/bids/${bidId}/authorize`,
            }),
          cancel: cancelBid,
        });
        if (out.kind === 'held') {
          authorizeAction.current.reset();
          return heldDone(out.bidId);
        }
        setFailure({
          text:
            out.kind === 'not_held'
              ? "PayPal hasn't confirmed your hold yet. Try again in a moment."
              : out.cancelled
                ? 'Card verification was cancelled. Nothing was held.'
                : "Your card couldn't be verified. Check the details and try again, or use PayPal.",
          retry: 'CARD',
        });
        return;
      }

      // Switching away from a half-done card bid: release it first (D3: one live bid).
      await cardHold.current.release({ cancel: cancelBid });
      const placed = await placeBid();
      if (placed.status === 'HELD') return heldDone(placed.bidId);
      if (pay === 'PAYPAL' && placed.approveUrl) {
        window.location.assign(placed.approveUrl); // rel=payer-action; PayPal returns to /api/bids/return
        return;
      }
      setFailure({ text: 'We could not confirm your hold. Check My bids before trying again.' });
    } catch (err) {
      const e =
        err instanceof ApiError ? err : new ApiError(0, 'CLIENT_ERROR', 'Something went wrong.');
      const f = holdFailure(e, amount);
      if (f.kind === 'already_bid' || f.kind === 'closed') {
        bidAction.current.reset();
        await fetchOffer();
        if (f.kind === 'closed') setFailure({ text: f.text });
      } else if (f.kind === 'session') {
        bidAction.current.reset();
        await fetchOffer(); // re-binds an anonymous shopper cookie
        setFailure({ text: f.text, retry: pay });
      } else {
        setFailure({ text: f.text, retry: f.kind === 'retry' ? pay : undefined });
      }
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  };

  function heldDone(bidId: string) {
    bidAction.current.reset();
    navigate(`/bids/${bidId}?held=1`);
  }

  const primaryLabel = busy === method ? 'Placing your hold…' : holdLabel(method, amount);
  const showForm = mode === 'bid';

  return (
    <div className={cn('flex flex-col gap-10 pt-6 lg:pt-12', showForm && 'pb-24 lg:pb-0')}>
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_440px] lg:gap-12">
        {/* Product */}
        <div className="flex flex-col gap-6">
          <ProductHero offer={offer} />
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[15px] text-body">{offer.brand.name}</span>
              {offer.brand.verified && <Badge tone="success">Verified brand</Badge>}
            </div>
            <h1 className="text-[28px] leading-[1.1] font-medium tracking-headline text-ink sm:text-[40px]">
              {offer.product.title ?? 'Untitled product'}
            </h1>
            {anchorText(offer) && (
              <p className="text-[15px] text-body">
                {offer.publicOffer?.url ? (
                  <a
                    href={offer.publicOffer.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline"
                  >
                    {anchorText(offer)}
                  </a>
                ) : (
                  anchorText(offer)
                )}
              </p>
            )}
            {offer.priceWatchPaused && <PriceWatchPausedBanner />}
          </div>
          <div className="hidden lg:flex lg:flex-col lg:gap-10">
            <HowItWorks />
            <Faq />
          </div>
        </div>

        {/* Bid card */}
        <aside className="flex flex-col gap-6 self-start rounded-md border border-line bg-white p-5 shadow-card sm:p-6 lg:sticky lg:top-6">
          <Countdown mode={mode} msLeft={msLeft} />

          {mode === 'already_bid' && (
            <MyBidPanel
              offer={offer}
              canRaise={offer.biddable || offer.status === 'ROUNDS'}
              onChanged={() => void fetchOffer()}
              onLower={() => {
                setAmount(Math.max(100, offer.myBid!.amountCents - 500));
                void fetchOffer();
              }}
            />
          )}
          {mode === 'rounds' && (
            <p className="text-[15px] text-body">
              Live rounds are on: new bids are closed and only existing bidders can raise.
            </p>
          )}
          {mode === 'closed' && (
            <p className="text-[15px] text-body">This window has closed. No new bids are taken.</p>
          )}

          {showForm && (
            <>
              <PriceInput
                amount={amount}
                onChange={changeAmount}
                range={sliderRange(offer, amount)}
                hint={priceHint(offer)}
                disabled={!!busy}
              />

              {warningFor && warning && (
                <div
                  role="alertdialog"
                  aria-labelledby="over-q"
                  className="flex flex-col gap-3 rounded-md bg-orange-tint p-4"
                >
                  <p id="over-q" className="text-[15px] text-ink">
                    {warning}
                  </p>
                  <p className="text-[13px] text-body">{NO_RELEASE_COPY}</p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      onClick={() => {
                        setOverConfirmed(true);
                        void hold(warningFor, true);
                      }}
                    >
                      Still bid {formatUsd(amount)}
                    </Button>
                    <Button variant="ghost" onClick={() => setWarningFor(null)}>
                      Change my price
                    </Button>
                  </div>
                </div>
              )}

              <fieldset className="flex flex-col gap-3" disabled={!!busy}>
                <legend className="label mb-3 text-[12px] text-muted">Pay with</legend>
                <div role="radiogroup" className="grid grid-cols-2 gap-2">
                  {(['PAYPAL', 'CARD'] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      role="radio"
                      aria-checked={method === m}
                      disabled={m === 'CARD' && !cardAvailable}
                      onClick={() => {
                        setMethod(m);
                        setFailure(null);
                      }}
                      className={cn(
                        'h-11 rounded-sm border text-[14px] font-medium disabled:cursor-not-allowed disabled:opacity-50',
                        method === m
                          ? 'border-orange bg-orange-tint text-ink'
                          : 'border-border bg-white text-body',
                      )}
                    >
                      {m === 'PAYPAL' ? 'PayPal' : 'Card'}
                    </button>
                  ))}
                </div>
                {!cardAvailable && (
                  <p className="text-[12px] text-muted">
                    Card fields need the PayPal sandbox (not the local stub).
                  </p>
                )}
                {method === 'CARD' && cardAvailable && (
                  <CardFields
                    clientId={cfg.paypalClientId!}
                    sandbox={cfg.paypalSandbox}
                    onSession={setCardSession}
                  />
                )}
              </fieldset>

              {overConfirmed && warning && (
                <p className="text-[13px] text-body">{NO_RELEASE_COPY}</p>
              )}
              {failure && (
                <div
                  role="alert"
                  className="flex flex-col gap-2 rounded-md border border-danger/30 bg-danger-tint p-3"
                >
                  <p className="text-[14px] text-ink">{failure.text}</p>
                  {failure.retry && (
                    <Button
                      variant="outline"
                      onClick={() => void hold(failure.retry!)}
                      disabled={!!busy}
                    >
                      Try again
                    </Button>
                  )}
                </div>
              )}

              {/* Desktop only; on phones the sticky bottom bar carries the primary action. */}
              <div className="hidden lg:block">
                <Button size="lg" block onClick={() => void hold(method)} disabled={!!busy}>
                  {primaryLabel}
                </Button>
              </div>

              {cfg.testCardEnabled && (
                <div className="flex flex-col gap-2 rounded-md border border-dashed border-planned p-3">
                  <Button
                    variant="outline"
                    block
                    onClick={() => void hold('TEST_CARD')}
                    disabled={!!busy}
                  >
                    {busy === 'TEST_CARD' ? 'Placing your hold…' : 'Use sandbox test card'}
                  </Button>
                  <p className="text-[12px] text-muted">
                    Demo only: places a real PayPal sandbox hold for {formatUsd(amount)} with
                    PayPal's public test Visa. No real card is used.
                  </p>
                </div>
              )}

              <ShopperIdentity onSignedIn={() => void fetchOffer()} />
            </>
          )}
          <TrustRow />
        </aside>
      </div>

      <div className="flex flex-col gap-10 lg:hidden">
        <HowItWorks />
        <Faq />
      </div>

      {showForm && (
        // M01 sticky bottom bar (mobile): the primary action always in reach.
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-white/95 px-4 py-3 backdrop-blur lg:hidden">
          <Button size="lg" block onClick={() => void hold(method)} disabled={!!busy}>
            {primaryLabel}
          </Button>
        </div>
      )}
    </div>
  );
}

function ProductHero({ offer }: { offer: OfferView }) {
  return (
    <div className="flex aspect-[4/3] max-h-[480px] items-center justify-center overflow-hidden rounded-md bg-surface">
      {offer.product.imageUrl ? (
        <img
          src={offer.product.imageUrl}
          alt={offer.product.title ?? ''}
          className="h-full w-full object-contain"
        />
      ) : (
        <span className="label text-[12px] text-muted">{offer.brand.name}</span>
      )}
    </div>
  );
}

function Countdown({ mode, msLeft }: { mode: string; msLeft: number | null }) {
  const text = msLeft === null ? null : countdownText(msLeft);
  if (!text) return null;
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="label text-[12px] text-muted">
        {mode === 'rounds' || mode === 'already_bid' ? 'Ends in' : 'Window closes in'}
      </span>
      <span className="font-mono text-[18px] text-ink tabular-nums" aria-live="off">
        {text}
      </span>
    </div>
  );
}

/** Milliseconds until `deadline`, ticking each second; calls `onElapsed` once when it passes. */
function useCountdown(deadline: string | null, onElapsed: () => void): number | null {
  const [now, setNow] = useState(() => Date.now());
  const elapsed = useRef(onElapsed);
  elapsed.current = onElapsed;
  const target = deadline ? Date.parse(deadline) : null;
  useEffect(() => {
    if (target === null) return;
    let fired = false;
    const id = window.setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (!fired && t >= target) {
        fired = true;
        elapsed.current();
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [target]);
  return target === null ? null : target - now;
}

function OfferSkeleton() {
  return (
    <div className="grid gap-8 pt-6 lg:grid-cols-[minmax(0,1fr)_440px] lg:gap-12 lg:pt-12">
      <div className="flex flex-col gap-4">
        <Skeleton className="aspect-[4/3] max-h-[480px] w-full" />
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-10 w-3/4" />
      </div>
      <div className="flex flex-col gap-4 rounded-md border border-line p-6">
        <MoneySkeleton />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-11 w-full" />
      </div>
    </div>
  );
}
