import { useCallback, useEffect, useId, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { PageHeader } from '../../components/layout/AppShell';
import { Badge, Button, ErrorBanner, Skeleton, useToast } from '../../components/ui';
import { ApiAction, ApiError, api, type HttpMethod } from '../../lib/api';
import type { BrandRole } from '../../lib/brand-gate';
import { RECHECK_MS, statusPill } from '../../lib/brand-onboarding';
import {
  dnsCheckMessage,
  domainsText,
  isLastOwner,
  NOTIFICATION_TEMPLATES,
  parseDomainsInput,
  PAYOUT_RELOGIN_URL,
  permissionsFor,
  reauthNotice,
  ROLE_COPY,
  SETTINGS_TABS,
  tabFromSearch,
  type BrandSettings as Settings,
  type DnsCheckAnswer,
  type NotificationChannel,
  type NotificationTemplate,
  type SettingsTab,
} from '../../lib/brand-settings';
import { cn } from '../../lib/cn';
import { paths } from '../../lib/routes';
import { useBrand } from './BrandGate';

/**
 * W11 Brand settings (HF-056; screens.md §W11): Team, Payout account, Verification, Authorized
 * retailers, Notifications. Fields a role can't change are shown read-only with the reason; the
 * API enforces the same rules (OWNER: team + payout; MANAGER+: retailers; anyone: own alerts).
 * The brand API keys tab is the production path, described in the README.
 */

const toApiError = (err: unknown) =>
  err instanceof ApiError ? err : new ApiError(0, 'CLIENT_ERROR', 'Something went wrong.');

/** One user action, one Idempotency-Key. */
function send<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
  return new ApiAction(api).run<T>({ method, path, ...(body === undefined ? {} : { body }) });
}

type Load =
  { state: 'loading' } | { state: 'error'; error: ApiError } | { state: 'ready'; data: Settings };

export function BrandSettings() {
  const { me } = useBrand();
  const location = useLocation();
  const navigate = useNavigate();
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const tab = tabFromSearch(location.search);
  const notice = reauthNotice(location.search);

  const reload = useCallback(async () => {
    try {
      const data = await api.request<Settings>({ method: 'GET', path: '/api/brands/me/settings' });
      setLoad({ state: 'ready', data });
    } catch (err) {
      setLoad({ state: 'error', error: toApiError(err) });
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const setTab = (t: SettingsTab) => navigate(`?tab=${t}`, { replace: true });

  if (load.state === 'loading') {
    return (
      <div className="flex flex-col gap-4 pt-8" aria-busy>
        <Skeleton className="h-10 w-80" />
        <Skeleton className="h-[260px] w-full max-w-[860px]" />
      </div>
    );
  }
  if (load.state === 'error') {
    return (
      <div className="pt-8">
        <ErrorBanner message={load.error.message} onRetry={() => void reload()} />
      </div>
    );
  }
  const data = load.data;
  const can = permissionsFor(data.me.role);

  return (
    <>
      <PageHeader
        eyebrow={data.brand.name}
        title="Brand settings."
        lede={`Signed in as ${me.email} · ${data.me.role.toLowerCase()}`}
      />
      <nav aria-label="Settings" className="flex flex-wrap gap-2 border-b border-line pb-3">
        {SETTINGS_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            aria-current={t.id === tab ? 'page' : undefined}
            className={cn(
              'label rounded-sm border px-3 py-2 text-[12px]',
              t.id === tab
                ? 'border-charcoal bg-charcoal text-white'
                : 'border-line bg-white text-body hover:bg-surface',
            )}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <div className="mt-8 flex max-w-[860px] flex-col gap-6">
        {tab === 'team' && <TeamTab data={data} canManage={can.manageTeam} onChange={reload} />}
        {tab === 'payout' && (
          <PayoutTab data={data} canChange={can.changePayout} notice={notice} onChange={reload} />
        )}
        {tab === 'verification' && <VerificationTab data={data} onChange={reload} />}
        {tab === 'retailers' && (
          <RetailersTab data={data} canEdit={can.editRetailers} onChange={reload} />
        )}
        {tab === 'notifications' && <NotificationsTab data={data} onChange={reload} />}
        <AccountCard isAdmin={!!me.isAdmin} />
      </div>
    </>
  );
}

/**
 * v4 Settings › Account (frame 113:125): switch to the buyer side (a separate session), sign out,
 * and the W20 Ops console for `ADMIN_EMAILS` members only (the API enforces it too).
 */
function AccountCard({ isAdmin }: { isAdmin: boolean }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const signOut = async () => {
    setBusy(true);
    try {
      await send('POST', '/api/auth/logout', { who: 'brand' });
      navigate(paths.home);
    } catch {
      setBusy(false);
    }
  };
  const row = 'flex items-center justify-between gap-4 border-t border-line py-4';
  const action = 'font-mono text-[13px] text-ink hover:underline';
  return (
    <section aria-label="Account" className="flex flex-col border border-line bg-white px-5 pt-5">
      <h2 className="label pb-4 text-[11px] text-muted">Account</h2>
      <div className={row}>
        <div className="flex flex-col">
          <span className="text-[15px] text-ink">Signed in as a brand</span>
          <span className="text-[13px] text-body">Switch to your buyer account to place bids</span>
        </div>
        <Link to={paths.bids} className={action}>
          Switch to buyer →
        </Link>
      </div>
      <div className={row}>
        <span className="text-[15px] text-ink">Sign out</span>
        <button type="button" className={action} disabled={busy} onClick={() => void signOut()}>
          {busy ? 'Signing out…' : 'Sign out →'}
        </button>
      </div>
      {isAdmin && (
        <div className={row}>
          <div className="flex flex-col">
            <span className="text-[15px] text-ink">Ops console</span>
            <span className="text-[13px] text-body">Shown to Holdfast admins only</span>
          </div>
          <Link to={paths.admin} className={action}>
            Open →
          </Link>
        </div>
      )}
    </section>
  );
}

function ReadOnlyNote({ children }: { children: string }) {
  return (
    <p role="note" className="rounded-sm border border-line bg-surface p-3 text-[13px] text-body">
      {children}
    </p>
  );
}

function SectionTitle({ children }: { children: string }) {
  return <h2 className="text-[22px] font-medium text-ink">{children}</h2>;
}

// --- Team ----------------------------------------------------------------------------------------

function TeamTab({
  data,
  canManage,
  onChange,
}: {
  data: Settings;
  canManage: boolean;
  onChange(): Promise<void>;
}) {
  const toast = useToast();
  const [role, setRole] = useState<BrandRole>('VIEWER');
  const [email, setEmail] = useState('');
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const roleId = useId();
  const emailId = useId();

  const run = async (id: string, fn: () => Promise<unknown>, done?: string) => {
    if (busy) return;
    setBusy(id);
    setError(null);
    try {
      await fn();
      await onChange();
      if (done) toast.show({ title: done, tone: 'success' });
    } catch (err) {
      setError(toApiError(err).message);
    } finally {
      setBusy(null);
    }
  };

  const createLink = () =>
    run('invite', async () => {
      const to = email.trim();
      const res = await send<{ url: string }>('POST', '/api/brands/me/invites', {
        role,
        ...(to ? { email: to } : {}),
      });
      setLink(res.url);
      setEmail('');
    });

  const copy = async () => {
    if (!link) return;
    const ok = await navigator.clipboard?.writeText(link).then(
      () => true,
      () => false,
    );
    toast.show({ title: ok ? 'Invite link copied' : 'Copy failed: select the link instead' });
  };

  return (
    <section aria-label="Team" className="flex flex-col gap-6">
      <SectionTitle>Team</SectionTitle>
      {canManage ? (
        <div className="flex flex-col gap-4 border border-line bg-white p-5">
          <p className="text-[15px] text-body">
            Invite by email, then send your teammate the link. They sign in with PayPal and join
            with the role you pick; with an email, only that address can use it. Links work once and
            last 7 days.
          </p>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <label htmlFor={emailId} className="label text-[12px] text-ink">
                Email (optional)
              </label>
              <input
                id={emailId}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="teammate@yourbrand.com"
                autoComplete="off"
                className="h-9 min-w-0 rounded-sm border border-border bg-white px-3 text-[14px]"
              />
            </div>
            <div className="flex flex-col gap-2">
              <label htmlFor={roleId} className="label text-[12px] text-ink">
                Role
              </label>
              <select
                id={roleId}
                value={role}
                onChange={(e) => setRole(e.target.value as BrandRole)}
                className="h-9 rounded-sm border border-border bg-white px-2 text-[14px]"
              >
                <option value="VIEWER">Viewer</option>
                <option value="MANAGER">Manager</option>
                <option value="OWNER">Owner</option>
              </select>
            </div>
            <Button onClick={() => void createLink()} disabled={!!busy}>
              {busy === 'invite' ? 'Creating…' : '+ Invite teammate'}
            </Button>
          </div>
          <p className="text-[13px] text-muted">{ROLE_COPY[role]}</p>
          {link && (
            <div className="flex flex-col gap-3 rounded-sm border border-line bg-surface p-4 sm:flex-row sm:items-center sm:justify-between">
              <code className="font-mono text-[13px] break-all text-ink">{link}</code>
              <Button variant="outline" onClick={() => void copy()}>
                Copy
              </Button>
            </div>
          )}
          {link && (
            <p className="text-[13px] text-muted">
              Shown once. Lost it? Cancel it below and create another.
            </p>
          )}
        </div>
      ) : (
        <ReadOnlyNote>Only a brand owner can invite teammates or change roles.</ReadOnlyNote>
      )}

      {error && <ErrorBanner message={error} />}

      <table className="w-full border-collapse text-left text-[14px]">
        <thead>
          <tr className="label border-b border-line text-[12px] text-muted">
            <th className="py-2 font-normal">Member</th>
            <th className="py-2 font-normal">Role</th>
            <th className="py-2" />
          </tr>
        </thead>
        <tbody>
          {data.team.members.map((m) => {
            const locked = isLastOwner(data.team.members, m.id);
            return (
              <tr key={m.id} className="border-b border-line">
                <td className="py-3 pr-3">
                  <span className="text-ink">{m.displayName ?? m.email}</span>
                  {m.displayName && <span className="block text-[12px] text-muted">{m.email}</span>}
                  {m.id === data.me.id && <Badge tone="neutral">You</Badge>}
                </td>
                <td className="py-3 pr-3">
                  {canManage && !locked ? (
                    <select
                      aria-label={`Role for ${m.email}`}
                      value={m.role}
                      disabled={!!busy}
                      onChange={(e) =>
                        void run(
                          `role-${m.id}`,
                          () =>
                            send('PATCH', `/api/brands/me/team/${m.id}`, { role: e.target.value }),
                          'Role updated',
                        )
                      }
                      className="h-8 rounded-sm border border-border bg-white px-2 text-[13px]"
                    >
                      <option value="OWNER">Owner</option>
                      <option value="MANAGER">Manager</option>
                      <option value="VIEWER">Viewer</option>
                    </select>
                  ) : (
                    <span title={locked ? 'Your brand needs at least one owner.' : undefined}>
                      {m.role.charAt(0) + m.role.slice(1).toLowerCase()}
                    </span>
                  )}
                </td>
                <td className="py-3 text-right">
                  {canManage && !locked && (
                    <Button
                      variant="ghost"
                      disabled={!!busy}
                      onClick={() => {
                        if (!window.confirm(`Remove ${m.email} from ${data.brand.name}?`)) return;
                        void run(
                          `remove-${m.id}`,
                          () => send('DELETE', `/api/brands/me/team/${m.id}`),
                          'Teammate removed',
                        );
                      }}
                    >
                      Remove
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {canManage && data.team.invites.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="label text-[12px] text-muted">Open invite links</p>
          {data.team.invites.map((i) => (
            <div
              key={i.id}
              className="flex items-center justify-between border-b border-line py-2 text-[14px]"
            >
              <span>
                {i.role.charAt(0) + i.role.slice(1).toLowerCase()} · created{' '}
                {new Date(i.createdAt).toLocaleDateString()}
                {i.expiresAt && ` · expires ${new Date(i.expiresAt).toLocaleDateString()}`}
              </span>
              <Button
                variant="ghost"
                disabled={!!busy}
                onClick={() =>
                  void run(
                    `revoke-${i.id}`,
                    () => send('DELETE', `/api/brands/me/invites/${i.id}`),
                    'Invite link cancelled',
                  )
                }
              >
                Cancel link
              </Button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// --- Payout account ------------------------------------------------------------------------------

function PayoutTab({
  data,
  canChange,
  notice,
  onChange,
}: {
  data: Settings;
  canChange: boolean;
  notice: ReturnType<typeof reauthNotice>;
  onChange(): Promise<void>;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = data.payout.pendingEmail;

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await send('POST', '/api/brands/me/payout-account');
      await onChange();
      toast.show({ title: 'Payout account updated', tone: 'success' });
    } catch (err) {
      setError(toApiError(err).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Payout account" className="flex flex-col gap-5">
      <SectionTitle>Payout account</SectionTitle>
      <div className="flex flex-col gap-2 border border-line bg-white p-5">
        <p className="label text-[12px] text-muted">PayPal business account</p>
        <p className="font-mono text-[16px] break-all text-ink">{data.payout.email}</p>
        <p className="text-[14px] text-body">
          Cleared windows pay out here. Payouts already in flight keep the account they were cleared
          with.
        </p>
      </div>

      {notice && (
        <p
          role={notice.tone === 'error' ? 'alert' : 'status'}
          className={cn('text-[14px]', notice.tone === 'error' ? 'text-danger' : 'text-ink')}
        >
          {notice.message}
        </p>
      )}

      {!canChange ? (
        <ReadOnlyNote>Only a brand owner can change the payout account.</ReadOnlyNote>
      ) : pending && pending !== data.payout.email ? (
        <div className="flex flex-col gap-3 rounded-md border border-orange/40 bg-orange-tint p-4">
          <p className="text-[14px] text-ink">
            Send future payouts to <span className="font-mono">{pending}</span>?
          </p>
          <div className="flex flex-wrap gap-3">
            <Button onClick={() => void confirm()} disabled={busy}>
              {busy ? 'Saving…' : 'Use this account'}
            </Button>
            <a
              className="label self-center text-[12px] text-body underline"
              href={PAYOUT_RELOGIN_URL}
            >
              Use a different PayPal account
            </a>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-[14px] text-body">
            To change it, sign in with PayPal as the new business account. We ask every time, so a
            stolen session can’t redirect your payouts. The change is recorded in the audit log.
          </p>
          <a
            href={PAYOUT_RELOGIN_URL}
            className="label inline-flex h-9 w-fit items-center rounded-sm bg-charcoal px-4 text-[13px] text-white hover:bg-ink"
          >
            Change payout account
          </a>
        </div>
      )}
      {error && <ErrorBanner message={error} />}
    </section>
  );
}

// --- Verification --------------------------------------------------------------------------------

function VerificationTab({ data, onChange }: { data: Settings; onChange(): Promise<void> }) {
  const toast = useToast();
  const { brand } = data;
  const pill = statusPill(brand.verificationStatus);
  const [answer, setAnswer] = useState<DnsCheckAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = brand.verificationStatus === 'PENDING';

  const check = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const a = await send<DnsCheckAnswer>('POST', '/api/brands/verification/check');
      setAnswer(a);
      if (a.verified) {
        await onChange();
        toast.show({ title: 'Brand verified', body: brand.name, tone: 'success' });
      }
    } catch (err) {
      setError(toApiError(err).message);
    } finally {
      setBusy(false);
    }
  }, [brand.name, onChange, toast]);

  const copyTxt = async () => {
    const ok = await navigator.clipboard?.writeText(brand.dnsTxtRecord ?? '').then(
      () => true,
      () => false,
    );
    toast.show({ title: ok ? 'TXT record copied' : 'Copy failed: select the record instead' });
  };

  // While PENDING with a domain, re-check every 30 s.
  useEffect(() => {
    if (!pending || !brand.domain) return;
    const t = setInterval(() => void check(), RECHECK_MS);
    return () => clearInterval(t);
  }, [pending, brand.domain, check]);

  return (
    <section aria-label="Verification status" className="flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <SectionTitle>Verification</SectionTitle>
        <Badge tone={pill.tone}>{pill.label}</Badge>
      </div>
      {brand.verificationStatus === 'VERIFIED' && (
        <p role="status" className="text-[14px] text-success">
          {brand.name} is verified
          {brand.verifiedAt ? ` since ${new Date(brand.verifiedAt).toLocaleDateString()}` : ''}.
          Shoppers see the Verified brand badge.
        </p>
      )}
      {brand.verificationStatus === 'REJECTED' && (
        <p role="alert" className="text-[14px] text-danger">
          We couldn’t verify this brand. Contact support@holdfast.example.
        </p>
      )}
      {brand.domain ? (
        <>
          <p className="text-[15px] text-body">
            TXT record on <span className="font-mono text-ink">{brand.domain}</span>:
          </p>
          <div className="flex flex-col gap-3 rounded-sm border border-line bg-surface p-4 sm:flex-row sm:items-center sm:justify-between">
            <code className="font-mono text-[14px] break-all text-ink">{brand.dnsTxtRecord}</code>
            <Button variant="outline" onClick={() => void copyTxt()}>
              Copy
            </Button>
          </div>
        </>
      ) : (
        <ReadOnlyNote>Add your website domain in onboarding to verify by DNS.</ReadOnlyNote>
      )}
      {pending && brand.domain && (
        <div className="flex flex-col gap-3">
          <Button
            variant="secondary"
            onClick={() => void check()}
            disabled={busy}
            className="w-fit"
          >
            {busy ? 'Checking…' : 'Check now'}
          </Button>
          <p role="status" className="text-[14px] text-body">
            {answer
              ? dnsCheckMessage(answer)
              : 'DNS changes can take up to an hour. This page re-checks every 30 seconds.'}
          </p>
        </div>
      )}
      {error && <ErrorBanner message={error} />}
    </section>
  );
}

// --- Authorized retailers ------------------------------------------------------------------------

function RetailersTab({
  data,
  canEdit,
  onChange,
}: {
  data: Settings;
  canEdit: boolean;
  onChange(): Promise<void>;
}) {
  const toast = useToast();
  const id = useId();
  const [text, setText] = useState(domainsText(data.authorizedDomains));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const parsed = parseDomainsInput(text, data.maxAuthorizedDomains);
  const count = parsed.ok ? parsed.domains.length : null;

  const save = async () => {
    if (busy) return;
    if (!parsed.ok) return setError(parsed.message);
    setBusy(true);
    setError(null);
    try {
      const res = await send<{ authorizedDomains: string[] }>(
        'PUT',
        '/api/brands/me/authorized-domains',
        { domains: parsed.domains },
      );
      setText(domainsText(res.authorizedDomains));
      await onChange();
      toast.show({ title: 'Authorized retailers saved', tone: 'success' });
    } catch (err) {
      setError(toApiError(err).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Authorized retailers" className="flex flex-col gap-5">
      <SectionTitle>Authorized retailers</SectionTitle>
      <p className="text-[15px] leading-[23px] text-body">
        The stores whose prices count. The price watcher releases a shopper’s hold when one of these
        sells the exact product for less, and the offer page shows the cheapest of them. Up to{' '}
        {data.maxAuthorizedDomains}.
      </p>
      {!canEdit && (
        <ReadOnlyNote>Viewers can see this list; a manager or owner can edit it.</ReadOnlyNote>
      )}
      <div className="flex flex-col gap-2">
        <label htmlFor={id} className="label text-[12px] text-ink">
          Retailer domains, one per line
        </label>
        <textarea
          id={id}
          rows={8}
          readOnly={!canEdit}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          className={cn(
            'w-full rounded-sm border border-border bg-white p-3 font-mono text-[14px] text-ink',
            !canEdit && 'bg-surface text-body',
          )}
          aria-invalid={!parsed.ok}
        />
        <p className={cn('text-[13px]', parsed.ok ? 'text-muted' : 'text-danger')}>
          {parsed.ok ? `${count} of ${data.maxAuthorizedDomains}` : parsed.message}
        </p>
      </div>
      {canEdit && (
        <Button onClick={() => void save()} disabled={busy || !parsed.ok} className="w-fit">
          {busy ? 'Saving…' : 'Save retailers'}
        </Button>
      )}
      {error && <ErrorBanner message={error} />}
    </section>
  );
}

// --- Notifications -------------------------------------------------------------------------------

function NotificationsTab({ data, onChange }: { data: Settings; onChange(): Promise<void> }) {
  const toast = useToast();
  const [prefs, setPrefs] = useState(data.notifications);
  const [error, setError] = useState<string | null>(null);

  const toggle = async (t: NotificationTemplate, c: NotificationChannel) => {
    const value = !prefs[t][c];
    setPrefs((p) => ({ ...p, [t]: { ...p[t], [c]: value } }));
    setError(null);
    try {
      const res = await send<{ notifications: Settings['notifications'] }>(
        'PUT',
        '/api/brands/me/notifications',
        { prefs: { [t]: { [c]: value } } },
      );
      setPrefs(res.notifications);
      // W11: each toggle saves at once; say so (UI-GAPS W11 "Saved" toast).
      toast.show({ title: 'Saved', tone: 'success', duration: 2000 });
      void onChange();
    } catch (err) {
      setPrefs(data.notifications);
      setError(toApiError(err).message);
    }
  };

  return (
    <section aria-label="Notifications" className="flex flex-col gap-5">
      <SectionTitle>Notifications</SectionTitle>
      <p className="text-[15px] text-body">
        Your own alerts. In-app alerts are always on; choose where else they reach you.
      </p>
      <table className="w-full border-collapse text-left text-[14px]">
        <thead>
          <tr className="label border-b border-line text-[12px] text-muted">
            <th className="py-2 font-normal">Alert</th>
            <th className="py-2 font-normal">Email</th>
            <th className="py-2 font-normal">Push</th>
          </tr>
        </thead>
        <tbody>
          {NOTIFICATION_TEMPLATES.map((t) => (
            <tr key={t.id} className="border-b border-line">
              <td className="py-3 pr-3">
                <span className="text-ink">{t.label}</span>
                <span className="block text-[12px] text-muted">{t.hint}</span>
              </td>
              {(['EMAIL', 'PUSH'] as const).map((c) => (
                <td key={c} className="py-3">
                  <input
                    type="checkbox"
                    aria-label={`${t.label} by ${c === 'EMAIL' ? 'email' : 'push'}`}
                    checked={prefs[t.id][c]}
                    onChange={() => void toggle(t.id, c)}
                    className="h-4 w-4 accent-orange"
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {error && <ErrorBanner message={error} />}
    </section>
  );
}
