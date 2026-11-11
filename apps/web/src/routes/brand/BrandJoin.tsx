import { useEffect, useId, useState } from 'react';
import { useNavigate } from 'react-router';
import { PageHeader } from '../../components/layout/AppShell';
import { Badge, Button, ErrorBanner, Skeleton } from '../../components/ui';
import { ApiAction, ApiError, api } from '../../lib/api';
import {
  INVITE_STORAGE_KEY,
  inviteTokenFromHash,
  joinError,
  ROLE_COPY,
} from '../../lib/brand-settings';
import type { BrandRole } from '../../lib/brand-gate';
import { clientConfig } from '../../lib/client-config';
import { paths } from '../../lib/routes';

/**
 * Invite join page (HF-056; features/01 §Logic 7). The copyable link is `/brand/join#hfi_…`: the
 * token stays in the fragment (never sent in a URL) and in sessionStorage across the Log in with
 * PayPal round trip, which comes back here (`next=/brand/join`). Joining re-issues the brand
 * session for the new `brand_users` row. In `DEMO_MODE` an email can be typed instead.
 */

interface Preview {
  brandName: string;
  role: BrandRole;
  state: 'OPEN' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';
  emailLocked: boolean;
}

interface Me {
  brandUser: { email: string; brand: { name: string } } | null;
  pendingBrand: { email: string } | null;
  demoMode: boolean;
}

const LIPP_START = `/api/auth/paypal/start?next=${encodeURIComponent(paths.brandJoin)}`;

function readToken(): string | null {
  const fromHash = inviteTokenFromHash(window.location.hash);
  if (fromHash) {
    sessionStorage.setItem(INVITE_STORAGE_KEY, fromHash);
    // Drop the secret from the address bar (and from history) once it is stored.
    window.history.replaceState(null, '', window.location.pathname);
    return fromHash;
  }
  return sessionStorage.getItem(INVITE_STORAGE_KEY);
}

export function BrandJoin() {
  const navigate = useNavigate();
  const emailId = useId();
  const [token] = useState(readToken);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');

  useEffect(() => {
    if (!token) return;
    let live = true;
    Promise.all([
      new ApiAction(api).run<Preview>({
        method: 'POST',
        path: '/api/invites/preview',
        body: { token },
      }),
      api.request<Me>({ method: 'GET', path: '/api/me' }),
    ]).then(
      ([p, m]) => {
        if (!live) return;
        setPreview(p);
        setMe(m);
      },
      (err) => {
        if (live) setError(joinError(err instanceof ApiError ? err : new ApiError(0, 'X', '')));
      },
    );
    return () => {
      live = false;
    };
  }, [token]);

  const join = async (demoEmail?: string) => {
    if (!token || busy) return;
    setBusy(true);
    setError(null);
    try {
      await new ApiAction(api).run({
        method: 'POST',
        path: '/api/invites/accept',
        body: { token, ...(demoEmail ? { email: demoEmail } : {}) },
      });
      sessionStorage.removeItem(INVITE_STORAGE_KEY);
      // A full load so the brand gate re-reads the new session.
      window.location.assign(paths.brand);
    } catch (err) {
      setError(joinError(err instanceof ApiError ? err : new ApiError(0, 'X', 'Failed.')));
    } finally {
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <>
        <PageHeader eyebrow="Team invite" title="This link is incomplete." />
        <p className="max-w-[640px] text-[15px] text-body">
          Open the full invite link your teammate sent you, including everything after the #.
        </p>
      </>
    );
  }
  if (!preview || !me) {
    return error ? (
      <div className="pt-8">
        <ErrorBanner message={error} />
      </div>
    ) : (
      <div className="flex flex-col gap-4 pt-8" aria-busy>
        <Skeleton className="h-10 w-80" />
        <Skeleton className="h-[160px] w-full max-w-[640px]" />
      </div>
    );
  }

  const open = preview.state === 'OPEN';
  const identity = me.brandUser?.email ?? me.pendingBrand?.email ?? null;
  const demo = me.demoMode || clientConfig().demoMode;

  return (
    <>
      <PageHeader
        eyebrow="Team invite"
        title={`Join ${preview.brandName}.`}
        lede="Holdfast clears overstock into demand that's already held."
      />
      <div className="flex max-w-[640px] flex-col gap-5">
        <div className="flex flex-col gap-2 border border-line bg-white p-5">
          <div className="flex items-center gap-3">
            <span className="label text-[12px] text-muted">Your role</span>
            <Badge tone="neutral">{preview.role.toLowerCase()}</Badge>
          </div>
          <p className="text-[14px] text-body">{ROLE_COPY[preview.role]}</p>
          {preview.emailLocked && (
            <p className="text-[13px] text-muted">This invite is for one specific email address.</p>
          )}
        </div>

        {!open && (
          <ErrorBanner
            message={joinError(
              new ApiError(409, 'STATE_CONFLICT', '', {
                reason:
                  preview.state === 'ACCEPTED'
                    ? 'INVITE_USED'
                    : preview.state === 'REVOKED'
                      ? 'INVITE_REVOKED'
                      : 'INVITE_EXPIRED',
              }),
            )}
          />
        )}

        {open && identity && (
          <div className="flex flex-col gap-3">
            <p className="text-[14px] text-body">
              Signed in as <span className="font-mono text-ink">{identity}</span>.
            </p>
            <Button onClick={() => void join()} disabled={busy} className="w-fit">
              {busy ? 'Joining…' : `Join ${preview.brandName}`}
            </Button>
          </div>
        )}
        {open && !identity && (
          <div className="flex flex-col gap-3">
            <a
              href={LIPP_START}
              className="label inline-flex h-[42px] w-fit items-center rounded-sm bg-orange px-4 text-[14px] text-white hover:bg-orange/90"
            >
              Continue with PayPal
            </a>
            <p className="text-[13px] text-muted">
              No password: you sign in with your PayPal account and come back here.
            </p>
          </div>
        )}
        {open && !identity && demo && (
          <form
            className="flex flex-col gap-2 border-t border-line pt-5"
            onSubmit={(e) => {
              e.preventDefault();
              void join(email.trim());
            }}
          >
            <label htmlFor={emailId} className="label text-[12px] text-ink">
              Demo: join with an email
            </label>
            <div className="flex flex-col gap-3 sm:flex-row">
              <input
                id={emailId}
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="teammate@example.com"
                className="h-9 flex-1 rounded-sm border border-border bg-white px-3 text-[14px]"
              />
              <Button type="submit" variant="outline" disabled={busy}>
                Join (demo)
              </Button>
            </div>
          </form>
        )}

        {error && <ErrorBanner message={error} />}
        <Button variant="ghost" className="w-fit" onClick={() => navigate(paths.home)}>
          Not now
        </Button>
      </div>
    </>
  );
}
