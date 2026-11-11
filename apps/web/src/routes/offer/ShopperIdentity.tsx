import { useEffect, useState, type FormEvent } from 'react';
import { useLocation } from 'react-router';
import { api } from '../../lib/api';
import { clientConfig } from '../../lib/client-config';
import { useApiAction } from '../../lib/use-api-action';
import { Button } from '../../components/ui';

interface Me {
  shopper: { id: string; email: string | null; provisional: boolean } | null;
}

/**
 * Who is bidding (D13). The first offer-page visit already bound an anonymous shopper to a cookie,
 * so a bid never waits for sign-in. The email is how a shopper finds their bids again:
 * `DEMO_MODE` signs in at once; otherwise a magic link (printed in the server console locally).
 */
export function ShopperIdentity({ onSignedIn }: { onSignedIn(): void }) {
  const { pathname, search } = useLocation();
  const [me, setMe] = useState<Me | null>(null);
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const signIn = useApiAction<Me>();
  const demo = clientConfig().demoMode;

  useEffect(() => {
    let live = true;
    api
      .request<Me>({ method: 'GET', path: '/api/me' })
      .then((m) => live && setMe(m))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  if (!me?.shopper) return null;
  if (!me.shopper.provisional) {
    return (
      <p className="text-[13px] text-body">
        Bidding as <span className="font-medium text-ink">{me.shopper.email}</span>
      </p>
    );
  }
  if (sent) {
    return (
      <p role="status" className="text-[13px] text-body">
        We sent a sign-in link to {email}. (Running locally? It's printed in the server console.)
      </p>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (demo) {
      const res = await signIn.run({
        method: 'POST',
        path: '/api/auth/demo/shopper',
        body: { email },
      });
      if (res?.shopper) {
        setMe(res);
        signIn.reset();
        onSignedIn();
      }
      return;
    }
    const ok = await signIn.run({
      method: 'POST',
      path: '/api/auth/shopper/magic-link',
      body: { email, next: `${pathname}${search}` },
    });
    if (ok !== undefined) setSent(true);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <label htmlFor="offer-email" className="text-[13px] text-body">
        You're bidding as a guest. Add your email to find your bids later
        {demo ? ' (demo: instant sign-in).' : '.'}
      </label>
      <div className="flex gap-2">
        <input
          id="offer-email"
          type="email"
          required
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="h-9 min-w-0 flex-1 rounded-sm border border-border px-3 text-[14px] focus:border-orange focus:outline-none"
        />
        <Button type="submit" variant="outline" disabled={signIn.status === 'pending'}>
          {signIn.status === 'pending' ? '…' : demo ? 'Sign in' : 'Email me a link'}
        </Button>
      </div>
      {signIn.status === 'error' && (
        <p role="alert" className="text-[13px] text-danger">
          {signIn.error.message}
        </p>
      )}
    </form>
  );
}
