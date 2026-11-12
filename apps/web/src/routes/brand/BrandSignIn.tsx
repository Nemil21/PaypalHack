import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Button, ErrorBanner } from '../../components/ui';
import { api } from '../../lib/api';
import { paypalStartUrl, safeNext, signInErrorMessage } from '../../lib/brand-sign-in';
import { clientConfig } from '../../lib/client-config';
import { paths } from '../../lib/routes';
import { BRAND_SIGN_IN as COPY, SHARED, withNext } from '../../lib/sign-in';
import { useApiAction } from '../../lib/use-api-action';
import { DemoPanel, OrDivider, SignInLayout } from '../auth/SignInLayout';
import type { BrandMe } from './BrandGate';

/**
 * W02 brand sign-in (HF-010; v4 Figma 109:112). "Continue with PayPal" is a full-page navigation to
 * `/api/auth/paypal/start`; PayPal returns to the callback, which lands on W03 or W04, or comes
 * back here with `?error=` (cancelled consent, bad state, failed exchange). With `DEMO_MODE` the
 * HF-006 demo OWNER / VIEWER sign-ins sit underneath (the path the console, tests and video use).
 * Brands have no email sign-in: an email link only ever creates a shopper session (plan §0).
 */

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
    <SignInLayout
      eyebrow={COPY.eyebrow}
      heading={COPY.heading}
      lede={COPY.lede}
      back={{ to: withNext(paths.signIn, next), label: SHARED.changeRole }}
      cardLabel="Sign in to Holdfast"
    >
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
        {redirecting ? COPY.redirecting : COPY.paypal}
      </Button>
      <p className="text-[13px] leading-[20px] text-body">{COPY.paypalNote}</p>

      {demo && (
        <>
          <OrDivider />
          <DemoPanel>
            <Button
              variant="secondary"
              size="lg"
              block
              onClick={() => asDemo('OWNER')}
              disabled={busy}
            >
              {COPY.demoOwner}
            </Button>
            <Button
              variant="outline"
              size="lg"
              block
              onClick={() => asDemo('VIEWER')}
              disabled={busy}
            >
              {COPY.demoViewer}
            </Button>
            {demoSignIn.status === 'error' && <ErrorBanner message={demoSignIn.error.message} />}
          </DemoPanel>
        </>
      )}

      <p className="text-[12px] leading-[18px] text-muted">
        {COPY.footnote} Holdfast never sees your PayPal password. By continuing you agree to the{' '}
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
    </SignInLayout>
  );
}
