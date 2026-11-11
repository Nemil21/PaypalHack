import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Badge, Button, ErrorBanner } from '../../components/ui';
import { api } from '../../lib/api';
import { paypalStartUrl, safeNext, signInErrorMessage } from '../../lib/brand-sign-in';
import { clientConfig } from '../../lib/client-config';
import { paths } from '../../lib/routes';
import { useApiAction } from '../../lib/use-api-action';
import type { BrandMe } from './BrandGate';

/**
 * W02 brand sign-in (HF-010). "Continue with PayPal" is a full-page navigation to
 * `/api/auth/paypal/start`; PayPal returns to the callback, which lands on W03 or W04, or comes
 * back here with `?error=` (cancelled consent, bad state, failed exchange). With `DEMO_MODE` the
 * HF-006 demo OWNER / VIEWER sign-ins sit underneath (the path the console, tests and video use).
 */

const VALUE_POINTS = [
  {
    n: '01',
    title: 'Demand that is already held',
    body: 'Every bid is a PayPal hold at the shopper’s price. You see real money, not wishlists.',
  },
  {
    n: '02',
    title: 'Clear privately, above your floor',
    body: 'Fill the units you choose at a single clearing price. Your public price never moves.',
  },
  {
    n: '03',
    title: 'Paid out to your PayPal account',
    body: 'No new password: the PayPal business account you sign in with is where payouts go.',
  },
];

export function BrandSignIn() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const demo = clientConfig().demoMode;
  const next = safeNext(params.get('next'));
  const errorMessage = signInErrorMessage(params.get('error'));
  const [redirecting, setRedirecting] = useState(false);
  const demoSignIn = useApiAction<{ brandUser: BrandMe }>();

  // Already signed in (or signed in with PayPal but not onboarded): skip the screen.
  useEffect(() => {
    let live = true;
    api
      .request<{ brandUser: BrandMe | null; pendingBrand?: { email: string } | null }>({
        method: 'GET',
        path: '/api/me',
      })
      .then((me) => {
        if (!live || params.get('error')) return;
        if (me.brandUser) {
          const verified = me.brandUser.brand.verificationStatus === 'VERIFIED';
          navigate(verified ? (next ?? paths.brand) : paths.brandOnboarding, { replace: true });
        } else if (me.pendingBrand) {
          navigate(paths.brandOnboarding, { replace: true });
        }
      })
      .catch(() => {
        // Stay on the sign-in screen.
      });
    return () => {
      live = false;
    };
  }, [navigate, next, params]);

  // Back from PayPal via the bfcache: the page is restored mid-"redirecting".
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) setRedirecting(false);
    };
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
  }, []);

  const continueWithPayPal = () => {
    setRedirecting(true);
    window.location.assign(paypalStartUrl(next));
  };

  const asDemo = async (role: 'OWNER' | 'VIEWER') => {
    demoSignIn.reset();
    const res = await demoSignIn.run({
      method: 'POST',
      path: '/api/auth/demo/brand',
      body: { role },
    });
    if (res?.brandUser) navigate(next ?? paths.brand, { replace: true });
  };

  const busy = redirecting || demoSignIn.status === 'pending';

  return (
    <div className="grid grid-cols-1 gap-10 pt-8 pb-16 lg:grid-cols-[1.1fr_1fr] lg:gap-16 lg:pt-16">
      <section className="flex flex-col gap-8">
        <div className="flex flex-col gap-3">
          <span className="label text-[13px] text-orange">Brand sign-in</span>
          <h1 className="text-[32px] leading-[1.1] font-medium tracking-headline text-ink sm:text-[44px] lg:text-[56px]">
            See money already waiting for your stock.
          </h1>
        </div>
        <ol className="flex flex-col border border-line">
          {VALUE_POINTS.map((p, i) => (
            <li key={p.n} className={i > 0 ? 'border-t border-line' : undefined}>
              <div className="flex flex-col gap-2 p-5">
                <p className="label flex gap-2.5 text-[13px]">
                  <span className="text-orange">{p.n}</span>
                  <span className="text-ink">{p.title}</span>
                </p>
                <p className="text-[15px] leading-[23px] text-body">{p.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section
        aria-labelledby="w02-title"
        className="flex flex-col gap-6 self-start border border-line bg-white p-6 lg:p-8"
      >
        <div className="flex flex-col gap-2">
          <h2 id="w02-title" className="text-[22px] font-medium text-ink">
            Sign in to Holdfast
          </h2>
          <p className="text-[15px] leading-[23px] text-body">
            Use the PayPal business account your payouts should go to. New brands verify next.
          </p>
        </div>

        {errorMessage && (
          <ErrorBanner message={errorMessage} onRetry={continueWithPayPal} retrying={redirecting} />
        )}

        <Button
          variant="primary"
          size="lg"
          block
          onClick={continueWithPayPal}
          disabled={busy}
          aria-busy={redirecting}
        >
          {redirecting ? 'Redirecting to PayPal…' : 'Continue with PayPal'}
        </Button>

        {demo && (
          <div className="flex flex-col gap-3 border-t border-line pt-6">
            <div className="flex items-center gap-2">
              <Badge tone="sim">Demo mode</Badge>
              <p className="text-[13px] text-muted">Seeded verified brand, no PayPal round trip.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => asDemo('OWNER')} disabled={busy}>
                Sign in as demo brand
              </Button>
              <Button variant="outline" onClick={() => asDemo('VIEWER')} disabled={busy}>
                Sign in as viewer
              </Button>
            </div>
            {demoSignIn.status === 'error' && <ErrorBanner message={demoSignIn.error.message} />}
          </div>
        )}

        <p className="text-[12px] leading-[18px] text-muted">
          Holdfast never sees your PayPal password. By continuing you agree to the{' '}
          <a
            className="underline underline-offset-4 hover:text-ink"
            href="https://www.paypal.com/us/legalhub/useragreement-full"
            target="_blank"
            rel="noreferrer"
          >
            PayPal User Agreement
          </a>{' '}
          and{' '}
          <a
            className="underline underline-offset-4 hover:text-ink"
            href="https://www.paypal.com/us/legalhub/privacy-full"
            target="_blank"
            rel="noreferrer"
          >
            Privacy Statement
          </a>
          .
        </p>
      </section>
    </div>
  );
}
