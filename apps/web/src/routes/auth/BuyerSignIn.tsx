import { useEffect, useId, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Button, ErrorBanner } from '../../components/ui';
import { api } from '../../lib/api';
import { safeNext } from '../../lib/brand-sign-in';
import { clientConfig } from '../../lib/client-config';
import { DEMO_OFFER_SLUG, paths } from '../../lib/routes';
import { BUYER_SIGN_IN as COPY, SHARED, withNext } from '../../lib/sign-in';
import { useApiAction } from '../../lib/use-api-action';
import { DemoPanel, OrDivider, SignInLayout } from './SignInLayout';

interface Me {
  shopper: { id: string; email: string | null; provisional: boolean } | null;
}

/**
 * v4 buyer sign-in (plan §0; Figma 109:132). Email link first (`POST /api/auth/shopper/magic-link`,
 * the same call as the offer page's `ShopperIdentity`); there is no PayPal login for buyers, since
 * the PayPal callback only creates brand sessions. In `DEMO_MODE`, "enter as Maya" signs in as the
 * seeded demo shopper (`POST /api/auth/demo/shopper`) and lands on My bids.
 */
export function BuyerSignIn() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const emailId = useId();
  const demo = clientConfig().demoMode;
  const next = safeNext(params.get('next')) ?? paths.bids;
  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const magicLink = useApiAction<{ sent: true }>();
  const demoSignIn = useApiAction<Me>();

  // Already signed in with an email: skip the screen.
  useEffect(() => {
    let live = true;
    api
      .request<Me>({ method: 'GET', path: '/api/me' })
      .then((me) => {
        if (live && me.shopper && !me.shopper.provisional) navigate(next, { replace: true });
      })
      .catch(() => {
        // Stay on the sign-in screen.
      });
    return () => {
      live = false;
    };
  }, [navigate, next]);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const to = email.trim();
    const ok = await magicLink.run({
      method: 'POST',
      path: '/api/auth/shopper/magic-link',
      body: { email: to, next },
    });
    if (ok !== undefined) setSentTo(to);
  };

  const asMaya = async () => {
    demoSignIn.reset();
    const res = await demoSignIn.run({ method: 'POST', path: '/api/auth/demo/shopper', body: {} });
    if (res?.shopper) navigate(next, { replace: true });
  };

  const busy = magicLink.status === 'pending' || demoSignIn.status === 'pending';

  return (
    <SignInLayout
      eyebrow={COPY.eyebrow}
      heading={COPY.heading}
      lede={COPY.lede}
      back={{ to: withNext(paths.signIn, safeNext(params.get('next'))), label: SHARED.changeRole }}
      cardLabel="Buyer sign-in"
    >
      {sentTo ? (
        <div className="flex flex-col gap-3">
          <p role="status" className="text-[15px] leading-[23px] text-ink">
            {COPY.sent(sentTo)}
          </p>
          <Button
            variant="ghost"
            className="w-fit"
            onClick={() => {
              magicLink.reset();
              setSentTo(null);
            }}
          >
            Use another email
          </Button>
        </div>
      ) : (
        <form onSubmit={send} className="flex flex-col gap-3">
          <label htmlFor={emailId} className="label text-[11px] text-body">
            {COPY.emailLabel}
          </label>
          <input
            id={emailId}
            type="email"
            required
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="h-[42px] min-w-0 rounded-sm border border-border bg-white px-3 text-[15px] text-ink focus:border-orange focus:outline-none"
          />
          <Button type="submit" variant="primary" size="lg" block disabled={busy}>
            {magicLink.status === 'pending' ? '…' : COPY.send}
          </Button>
          {magicLink.status === 'error' && <ErrorBanner message={magicLink.error.message} />}
        </form>
      )}
      <p className="text-[13px] leading-[20px] text-body">
        {COPY.linkNote} {COPY.placeBidLead}{' '}
        <Link
          to={paths.offer(DEMO_OFFER_SLUG)}
          className="text-ink underline underline-offset-4 hover:text-orange"
        >
          {COPY.placeBid}
        </Link>
        {COPY.placeBidTail}
      </p>

      {demo && (
        <>
          <OrDivider />
          <DemoPanel>
            <Button variant="secondary" size="lg" block onClick={asMaya} disabled={busy}>
              {demoSignIn.status === 'pending' ? '…' : COPY.demoMaya}
            </Button>
            {demoSignIn.status === 'error' && <ErrorBanner message={demoSignIn.error.message} />}
          </DemoPanel>
        </>
      )}
    </SignInLayout>
  );
}
