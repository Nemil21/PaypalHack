import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import type { MandateListBody } from '@holdfast/shared';
import { PageHeader } from '../components/layout/AppShell';
import { PushToggle } from '../components/PushToggle';
import { Badge, ButtonLink, ErrorBanner, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import {
  BUYER_NOTIFICATION_EVENTS,
  buyerSettingsState,
  paypalRow,
  profileView,
  READ_ONLY_NOTE,
} from '../lib/buyer-settings';
import { paths } from '../lib/routes';
import { useApiAction } from '../lib/use-api-action';
import type { MeResponse } from '../lib/viewer';
import { ShopperIdentity } from './offer/ShopperIdentity';

/**
 * v4 buyer settings (§2.3, frame 115:303): PayPal and profile (read-only, decision 5),
 * notifications (phone alerts switch + the events we send), switch to brand, sign out.
 * Reads `GET /api/me` and `GET /api/mandates` (saved PayPal method); no new API.
 */
export function BuyerSettings() {
  const [me, setMe] = useState<MeResponse | null | undefined>(undefined);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const [saved, setSaved] = useState<boolean | null>(null);

  useEffect(() => {
    let live = true;
    api
      .request<MeResponse>({ method: 'GET', path: '/api/me' })
      .then((m) => live && setMe(m))
      .catch(() => live && setMe(null));
    return () => {
      live = false;
    };
  }, [nonce]);

  const state = me === undefined ? null : buyerSettingsState(me);
  useEffect(() => {
    if (state !== 'signed-in') return;
    let live = true;
    api
      .request<MandateListBody>({ method: 'GET', path: '/api/mandates' })
      .then((b) => live && setSaved(b.savedPaymentMethod))
      .catch(() => live && setSaved(false));
    return () => {
      live = false;
    };
  }, [state]);

  const name = me ? profileView(me).name : null;

  return (
    <div className="mx-auto w-full max-w-[1120px]">
      <PageHeader
        eyebrow={state === 'signed-in' ? (name ?? undefined) : 'Buyer'}
        title="Settings"
      />
      {state === null ? (
        <div className="grid gap-5 lg:grid-cols-2" aria-busy>
          <Skeleton className="h-[220px] w-full" />
          <Skeleton className="h-[220px] w-full" />
        </div>
      ) : state !== 'signed-in' ? (
        <SignedOut guest={state === 'guest'} onSignedIn={reload} />
      ) : (
        <div className="grid items-start gap-5 lg:grid-cols-2">
          <div className="flex flex-col gap-5">
            <Card title="PayPal">
              <PayPalRows me={me!} saved={saved} />
            </Card>
            <Card title="Profile">
              <Row title="Display name" detail="Shown to brands as a shopper label only">
                <span className="text-[15px] text-ink">{name}</span>
              </Row>
              <p className="pt-4 text-[13px] text-muted">{READ_ONLY_NOTE}</p>
            </Card>
          </div>
          <div className="flex flex-col gap-5">
            <Card title="Notifications">
              <ul className="divide-y divide-line">
                {BUYER_NOTIFICATION_EVENTS.map((e) => (
                  <li key={e} className="flex items-center justify-between gap-4 py-3.5">
                    <span className="text-[15px] text-ink">{e}</span>
                    <span className="label shrink-0 text-[11px] text-muted">Always on</span>
                  </li>
                ))}
              </ul>
              <div className="flex flex-col gap-3 border-t border-line pt-4">
                <PushToggle audience="shopper" />
                <Link
                  to={paths.notifications}
                  className="self-start font-mono text-[13px] text-ink underline underline-offset-2"
                >
                  See all notifications
                </Link>
              </div>
            </Card>
            <AccountCard />
          </div>
        </div>
      )}
    </div>
  );
}

function PayPalRows({ me, saved }: { me: MeResponse; saved: boolean | null }) {
  const row = paypalRow(saved);
  const { email } = profileView(me);
  return (
    <>
      <Row title={email ?? 'No email yet'} detail="Sign-in links and receipts go here">
        {null}
      </Row>
      <Row title={row.title} detail={row.detail}>
        {row.badge && (
          <Badge tone={row.badge.tone} className="text-[10px]">
            {row.badge.label}
          </Badge>
        )}
      </Row>
      <Row title="Shipping address" detail="Taken from PayPal when a winning bid is charged">
        <span className="font-mono text-[13px] text-body">Read-only</span>
      </Row>
    </>
  );
}

function AccountCard() {
  const navigate = useNavigate();
  const signOut = useApiAction<unknown>();
  const onSignOut = async () => {
    const ok = await signOut.run({
      method: 'POST',
      path: '/api/auth/logout',
      body: { who: 'shopper' },
    });
    if (ok !== undefined) navigate(paths.home);
  };
  return (
    <Card title="Account">
      <Row title="Signed in as a buyer" detail="Switch to your brand account to manage listings">
        <Link to={paths.brand} className="font-mono text-[13px] whitespace-nowrap text-ink">
          Switch to brand <span aria-hidden>→</span>
        </Link>
      </Row>
      <div className="flex items-center justify-between gap-4 pt-4">
        <button
          type="button"
          onClick={() => void onSignOut()}
          disabled={signOut.status === 'pending'}
          className="flex w-full items-center justify-between text-left text-[15px] text-ink disabled:opacity-50"
        >
          {signOut.status === 'pending' ? 'Signing out…' : 'Sign out'}
          <span aria-hidden className="font-mono text-[13px]">
            →
          </span>
        </button>
      </div>
      {signOut.status === 'error' && (
        <ErrorBanner className="mt-3" message={signOut.error.message} onRetry={onSignOut} />
      )}
    </Card>
  );
}

function SignedOut({ guest, onSignedIn }: { guest: boolean; onSignedIn(): void }) {
  return (
    <div className="flex max-w-[560px] flex-col gap-4">
      <p className="text-[17px] text-body">
        {guest
          ? 'Add your email to keep your bids and settings on any device.'
          : 'Sign in to see your PayPal, notifications and account settings.'}
      </p>
      {guest ? (
        <ShopperIdentity onSignedIn={onSignedIn} />
      ) : (
        <ButtonLink to={paths.bids} className="self-start">
          Go to my bids
        </ButtonLink>
      )}
    </div>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section
      aria-label={title}
      className="rounded-md border border-line bg-white px-4 pt-5 pb-5 sm:px-6"
    >
      <h2 className="label border-b border-line pb-3 text-[11px] text-muted">{title}</h2>
      <div className="divide-y divide-line">{children}</div>
    </section>
  );
}

function Row({ title, detail, children }: { title: string; detail: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-4">
      <div className="min-w-0">
        <p className="text-[15px] break-words text-ink">{title}</p>
        <p className="mt-0.5 text-[13px] text-body">{detail}</p>
      </div>
      {children && <div className="shrink-0">{children}</div>}
    </div>
  );
}
