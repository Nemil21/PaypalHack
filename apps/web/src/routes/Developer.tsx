import { useCallback, useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import {
  MCP_TOOL_DOCS,
  type MandateListBody,
  type McpClientCreatedBody,
  type McpClientListBody,
  type McpClientRevokedBody,
  type McpClientView,
  type McpScope,
  type McpToolInfo,
  type McpToolListBody,
} from '@holdfast/shared';
import { AgentCodeCard } from '../components/marketing/AgentCodeCard';
import { Accent } from '../components/marketing/MarketingPage';
import {
  Badge,
  Button,
  ButtonLink,
  EmptyState,
  ErrorBanner,
  Skeleton,
  useToast,
} from '../components/ui';
import { ApiError, api } from '../lib/api';
import { clientConfig } from '../lib/client-config';
import { cn } from '../lib/cn';
import { brandDeveloper, brandGuides, buyerDeveloper, mandateSummary } from '../lib/developer';
import { widgetSnippet } from '../lib/embed';
import { claudeDesktopConfig, mcpEndpoint, readiness, relativeTime } from '../lib/mcp-connect';
import { paths } from '../lib/routes';
import { useApiAction } from '../lib/use-api-action';
import { viewerFor, type MeResponse } from '../lib/viewer';

/**
 * W19 Developer (HF-043; v4 frames 115:184 buyer, 113:235 brand). The role from `GET /api/me`
 * picks the view:
 * - **Brand** (decision 4): docs only. Guides into /docs and the embed-widget snippet; brand API
 *   keys aren’t available yet, so there is no key button.
 * - **Buyer**: create a scoped MCP token (one-time reveal), connect Claude Code / Codex / OpenCode
 *   (or Claude Desktop), manage tokens, see mandates and readiness, and the tools the agent gets,
 *   read live from the server's own `tools/list` (`GET /api/mcp/tools`).
 * - **Signed out**: buyer sign-in (DEMO_MODE demo shopper, or an email link).
 */

type Me = MeResponse;

type Load<T> =
  { status: 'loading' } | { status: 'error'; error: ApiError } | { status: 'ready'; data: T };

function asApiError(err: unknown): ApiError {
  return err instanceof ApiError ? err : new ApiError(0, 'CLIENT_ERROR', 'Something went wrong.');
}

function useGet<T>(path: string, enabled: boolean) {
  const [state, setState] = useState<Load<T>>({ status: 'loading' });
  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const data = await api.request<T>({ method: 'GET', path, signal });
        setState({ status: 'ready', data });
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setState({ status: 'error', error: asApiError(err) });
      }
    },
    [path],
  );
  useEffect(() => {
    if (!enabled) return;
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [enabled, load]);
  return { state, reload: () => void load(), setState };
}

function useCopy() {
  const toast = useToast();
  return useCallback(
    async (text: string, what: string) => {
      try {
        await navigator.clipboard.writeText(text);
        toast.show({ title: `${what} copied`, tone: 'success' });
      } catch {
        toast.show({ title: `Couldn't copy. Select the text and copy it.`, tone: 'error' });
      }
    },
    [toast],
  );
}

function SignIn({ onSignedIn }: { onSignedIn(): void }) {
  const demo = clientConfig().demoMode;
  const action = useApiAction<Me>();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const inputId = useId();

  const demoSignIn = async () => {
    if (await action.run({ method: 'POST', path: '/api/auth/demo/shopper', body: {} })) {
      onSignedIn();
    }
  };
  const magicLink = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await action.run({
      method: 'POST',
      path: '/api/auth/shopper/magic-link',
      body: { email, next: paths.developer },
    });
    if (ok !== undefined) setSent(true);
  };

  return (
    <Section title="Sign in" className="max-w-xl">
      <p className="text-[15px] text-body">
        A token acts as you, so sign in first. Tokens are tied to one shopper account.
      </p>
      {demo && (
        <Button onClick={demoSignIn} disabled={action.status === 'pending'} className="self-start">
          {action.status === 'pending' ? '…' : 'Sign in as demo shopper'}
        </Button>
      )}
      {sent ? (
        <p role="status" className="text-[14px] text-body">
          We sent a sign-in link to {email}. (Running locally? It's printed in the server console.)
        </p>
      ) : (
        <form onSubmit={magicLink} className="flex flex-col gap-2">
          <label htmlFor={inputId} className="text-[13px] text-body">
            {demo ? 'Or email yourself a sign-in link' : 'Email yourself a sign-in link'}
          </label>
          <div className="flex gap-2">
            <input
              id={inputId}
              type="email"
              required
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="h-9 min-w-0 flex-1 rounded-sm border border-border px-3 text-[14px] focus:border-orange focus:outline-none"
            />
            <Button type="submit" variant="outline" disabled={action.status === 'pending'}>
              Email me a link
            </Button>
          </div>
        </form>
      )}
      {action.status === 'error' && (
        <p role="alert" className="text-[13px] text-danger">
          {action.error.message}
        </p>
      )}
    </Section>
  );
}

function CreateForm({ onCreated }: { onCreated(body: McpClientCreatedBody): void }) {
  const create = useApiAction<McpClientCreatedBody>();
  const [name, setName] = useState('Claude Desktop');
  const [bid, setBid] = useState(true);
  const nameId = useId();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const scopes: McpScope[] = bid ? ['read', 'bid'] : ['read'];
    const body = await create.run({
      method: 'POST',
      path: '/api/mcp-clients',
      body: { name, scopes },
    });
    if (body) {
      // A token is a new action every time: the next submit mints a new key and a new token.
      create.reset();
      onCreated(body);
    }
  };

  return (
    <Section id="create-token" title="Create a token">
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <label htmlFor={nameId} className="text-[13px] text-body">
            Name
          </label>
          <input
            id={nameId}
            required
            maxLength={60}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-11 w-full rounded-sm border border-border bg-white px-3 text-[15px] text-ink sm:max-w-sm"
          />
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-[13px] text-body">Scopes</legend>
          <label className="flex items-start gap-3 text-[14px] text-ink">
            <input type="checkbox" checked disabled className="mt-1" />
            <span>
              <span className="font-medium">Read</span>
              <span className="text-body"> · see books and your own bids (always on)</span>
            </span>
          </label>
          <label className="flex items-start gap-3 text-[14px] text-ink">
            <input
              type="checkbox"
              checked={bid}
              onChange={(e) => setBid(e.target.checked)}
              className="mt-1"
            />
            <span>
              <span className="font-medium">Bid</span>
              <span className="text-body">
                {' '}
                · place, cancel and raise bids with real PayPal holds
              </span>
            </span>
          </label>
        </fieldset>
        {create.status === 'error' && (
          <p role="alert" className="text-[13px] text-danger">
            {create.error.message}
          </p>
        )}
        <Button
          type="submit"
          disabled={create.status === 'pending' || !name.trim()}
          className="self-start"
        >
          {create.status === 'pending' ? '…' : 'Create token'}
        </Button>
      </form>
    </Section>
  );
}

function Reveal({ created, onDone }: { created: McpClientCreatedBody; onDone(): void }) {
  const copy = useCopy();
  return (
    <section
      aria-live="polite"
      className="flex flex-col gap-4 rounded-md border border-orange/40 bg-orange-tint p-4 lg:p-6"
    >
      <h2 className="label text-[12px] text-orange">Token created · {created.client.name}</h2>
      <p className="text-[15px] text-ink">
        Copy it now. This is the only time it's shown; we store a hash, not the token.
      </p>
      <code className="block overflow-x-auto rounded-sm border border-border bg-white p-3 font-mono text-[13px] break-all text-ink">
        {created.token}
      </code>
      <div className="flex flex-wrap gap-3">
        <Button onClick={() => void copy(created.token, 'Token')}>Copy token</Button>
        <Button variant="outline" onClick={onDone}>
          I've saved it
        </Button>
      </div>
    </section>
  );
}

function ConfigSnippet({ origin, token }: { origin: string; token: string | null }) {
  const copy = useCopy();
  const snippet = claudeDesktopConfig(origin, token);
  return (
    <Section title="Claude Desktop">
      <p className="text-[14px] text-body">
        In Claude Desktop open Settings → Developer → Edit Config, add this to{' '}
        <code className="font-mono text-[13px] text-ink">claude_desktop_config.json</code> and
        restart. Needs Node.js for <code className="font-mono text-[13px] text-ink">npx</code>.
        {token
          ? ' Your new token is already filled in.'
          : ' Replace the token placeholder with yours.'}
      </p>
      <pre className="overflow-x-auto rounded-sm bg-charcoal p-4 font-mono text-[12px] leading-[18px] text-white">
        {snippet}
      </pre>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" onClick={() => void copy(snippet, 'Config')}>
          Copy MCP setup
        </Button>
        <span className="font-mono text-[12px] text-muted">{mcpEndpoint(origin)}</span>
      </div>
    </Section>
  );
}

function Section({
  title,
  children,
  className,
  id,
}: {
  title: string;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section
      id={id}
      className={cn(
        'flex flex-col gap-4 rounded-sm border border-line bg-white p-5 lg:p-6',
        className,
      )}
    >
      <h2 className="label border-b border-line pb-3 text-[11px] text-body">{title}</h2>
      {children}
    </section>
  );
}

function DevHeader({
  eyebrow,
  title,
  lede,
  action,
}: {
  eyebrow: string;
  title: ReactNode;
  lede?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 pt-8 pb-8 sm:flex-row sm:items-end sm:justify-between lg:pt-14 lg:pb-10">
      <div className="flex flex-col gap-3">
        <span className="label text-[13px] text-orange">{eyebrow}</span>
        <h1 className="text-[32px] leading-[1.1] font-medium tracking-headline text-ink sm:text-[44px] lg:text-[56px]">
          {title}
        </h1>
        {lede && (
          <p className="mt-2 max-w-[720px] text-[17px] leading-[26px] text-body sm:text-[19px] sm:leading-[29px]">
            {lede}
          </p>
        )}
      </div>
      {action}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

export function DeveloperPage() {
  const me = useGet<Me>('/api/me', true);
  const viewer = me.state.status === 'ready' ? viewerFor(me.state.data, paths.developer) : null;

  if (me.state.status === 'loading') return <Skeleton className="mt-10 h-40" />;
  if (me.state.status === 'error')
    return (
      <div className="pt-10">
        <ErrorBanner message={me.state.error.message} onRetry={me.reload} />
      </div>
    );
  if (viewer?.role === 'brand') return <BrandDeveloper />;
  const shopper = me.state.data.shopper;
  const signedIn = !!shopper && !shopper.provisional;
  return (
    <BuyerDeveloper signedIn={signedIn} email={shopper?.email ?? null} onSignedIn={me.reload} />
  );
}

// --- Brand: docs only (decision 4) -----------------------------------------------------------

function BrandDeveloper() {
  const snippet = widgetSnippet(window.location.origin, 'your-listing-slug', 'light');
  const copy = useCopy();
  return (
    <div className="pb-16">
      <DevHeader
        eyebrow={brandDeveloper.eyebrow}
        title={brandDeveloper.title}
        lede={brandDeveloper.lede}
      />
      <div className="flex flex-col gap-6">
        <Section title={brandDeveloper.guidesTitle}>
          <ul className="-mt-1 flex flex-col divide-y divide-line">
            {brandGuides.map((g) => (
              <li key={g.title}>
                <Link
                  to={g.to}
                  className="group flex flex-col gap-1 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
                >
                  <span>
                    <span className="block text-[16px] text-ink">{g.title}</span>
                    <span className="block text-[14px] text-body">{g.body}</span>
                  </span>
                  <span className="shrink-0 font-mono text-[13px] text-ink group-hover:text-orange">
                    Read in Docs →
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Section>
        <Section title={brandDeveloper.embedTitle}>
          <pre className="overflow-x-auto rounded-sm bg-surface p-4 font-mono text-[12px] leading-[20px] text-ink sm:text-[13px]">
            {snippet}
          </pre>
          <p className="text-[14px] text-body">{brandDeveloper.embedNote}</p>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <Button variant="outline" onClick={() => void copy(snippet, 'Snippet')}>
              Copy snippet
            </Button>
            <Link
              to={paths.brandEmbed}
              className="font-mono text-[13px] text-ink underline underline-offset-4 hover:text-orange"
            >
              Embed &amp; share →
            </Link>
            <Link
              to={`${paths.docs}#open-a-window`}
              className="font-mono text-[13px] text-ink underline underline-offset-4 hover:text-orange"
            >
              {brandDeveloper.reference} →
            </Link>
          </div>
        </Section>
      </div>
    </div>
  );
}

// --- Buyer: MCP tokens --------------------------------------------------------------------------

function BuyerDeveloper({
  signedIn,
  email,
  onSignedIn,
}: {
  signedIn: boolean;
  email: string | null;
  onSignedIn(): void;
}) {
  const [creating, setCreating] = useState(false);
  return (
    <div className="pb-16">
      <DevHeader
        eyebrow={buyerDeveloper.eyebrow}
        title={
          <>
            {buyerDeveloper.lead}
            <Accent>{buyerDeveloper.accent}</Accent>
          </>
        }
        lede={
          signedIn
            ? undefined
            : 'Connect Claude Code, Codex or any MCP client with a token scoped to your account. Bids it places use your own PayPal, under the limits you set.'
        }
        action={
          signedIn && (
            <Button
              size="lg"
              onClick={() => {
                setCreating(true);
                requestAnimationFrame(() =>
                  document.getElementById('create-token')?.scrollIntoView({ block: 'center' }),
                );
              }}
              className="self-start sm:self-auto"
            >
              + {buyerDeveloper.createCta}
            </Button>
          )
        }
      />
      {signedIn ? (
        <Connect email={email} creating={creating} onCreatingDone={() => setCreating(false)} />
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <SignIn onSignedIn={onSignedIn} />
          <ToolList />
        </div>
      )}
    </div>
  );
}

function Connect({
  email,
  creating,
  onCreatingDone,
}: {
  email: string | null;
  creating: boolean;
  onCreatingDone(): void;
}) {
  const clients = useGet<McpClientListBody>('/api/mcp-clients', true);
  const mandates = useGet<MandateListBody>('/api/mandates', true);
  const [created, setCreated] = useState<McpClientCreatedBody | null>(null);
  const origin = window.location.origin;
  const hasTokens = clients.state.status === 'ready' && clients.state.data.clients.length > 0;
  const showCreate = creating || (clients.state.status === 'ready' && !hasTokens);

  const onCreated = (body: McpClientCreatedBody) => {
    setCreated(body);
    onCreatingDone();
    clients.setState((s) =>
      s.status === 'ready'
        ? { status: 'ready', data: { clients: [body.client, ...s.data.clients] } }
        : s,
    );
  };
  const onRevoked = (client: McpClientView) => {
    if (created?.client.id === client.id) setCreated(null);
    clients.setState((s) =>
      s.status === 'ready'
        ? {
            status: 'ready',
            data: { clients: s.data.clients.map((c) => (c.id === client.id ? client : c)) },
          }
        : s,
    );
  };

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-6">
        {created && <Reveal created={created} onDone={() => setCreated(null)} />}
        <AgentCodeCard
          className="w-full bg-white"
          token={created?.token ?? null}
          footer={buyerDeveloper.tryLine}
        />
        {/* Below an open reveal, never instead of it: the reveal is the only copy of that token. */}
        {showCreate && <CreateForm onCreated={onCreated} />}
        <TokenList
          state={clients.state}
          email={email}
          onRetry={clients.reload}
          onRevoked={onRevoked}
        />
        <details className="group rounded-sm border border-line bg-white p-5 lg:p-6">
          <summary className="label cursor-pointer text-[11px] text-body marker:text-muted">
            Claude Desktop (JSON config)
          </summary>
          <div className="mt-4">
            <ConfigSnippet origin={origin} token={created?.token ?? null} />
          </div>
        </details>
      </div>
      <div className="flex min-w-0 flex-col gap-6">
        <MandatesPanel state={mandates.state} onRetry={mandates.reload} />
        <ToolList />
      </div>
    </div>
  );
}

function TokenList({
  state,
  email,
  onRetry,
  onRevoked,
}: {
  state: Load<McpClientListBody>;
  email: string | null;
  onRetry(): void;
  onRevoked(client: McpClientView): void;
}) {
  return (
    <Section title="Your tokens">
      {state.status === 'loading' && <Skeleton className="h-24" />}
      {state.status === 'error' && <ErrorBanner message={state.error.message} onRetry={onRetry} />}
      {state.status === 'ready' && state.data.clients.length === 0 && (
        <EmptyState message="No tokens yet. Create one to connect an agent." />
      )}
      {state.status === 'ready' && state.data.clients.length > 0 && (
        <ul className="-mt-1 flex flex-col divide-y divide-line">
          {state.data.clients.map((c) => (
            <TokenRow key={c.id} client={c} onRevoked={onRevoked} />
          ))}
        </ul>
      )}
      {email && (
        <p className="text-[13px] text-muted">
          Tokens act as <span className="text-ink">{email}</span>. Revoke one and it stops working
          immediately.
        </p>
      )}
    </Section>
  );
}

function MandatesPanel({ state, onRetry }: { state: Load<MandateListBody>; onRetry(): void }) {
  if (state.status === 'loading') return <Skeleton className="h-48" />;
  if (state.status === 'error')
    return <ErrorBanner message={state.error.message} onRetry={onRetry} />;
  const r = readiness(state.data);
  const live = state.data.mandates.filter((m) => m.state === 'active' || m.state === 'paused');
  return (
    <Section title={buyerDeveloper.mandatesTitle}>
      <p className="text-[15px] leading-[23px] text-body">{buyerDeveloper.mandatesLede}</p>
      {live.length > 0 && (
        <ul className="flex flex-col divide-y divide-line border-t border-line">
          {live.map((m) => {
            const s = mandateSummary(m);
            return (
              <li key={m.mandateId}>
                <Link
                  to={paths.mandate(m.mandateId)}
                  className="flex items-center justify-between gap-4 py-4 hover:bg-surface/60"
                >
                  <span className="min-w-0">
                    <span className="block text-[16px] text-ink">{s.title}</span>
                    <span className="block truncate text-[14px] text-body">{s.detail}</span>
                  </span>
                  <Badge tone={m.state === 'active' ? 'success' : 'neutral'}>{m.state}</Badge>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      <ul className="flex flex-col gap-2 border-t border-line pt-4">
        <Check ok={r.savedCard}>Saved card</Check>
        <Check ok={r.mandate !== null}>
          {r.mandate ? `Active mandate covering ${r.mandate.label}` : 'Active mandate'}
        </Check>
      </ul>
      <p className="text-[14px] text-body">
        {r.ready
          ? `Your agent's bids up to ${r.mandate!.label} are held at once.`
          : "Until both are ticked, your agent's bids come back as a link for you to approve the PayPal hold."}
      </p>
      <div className="flex flex-wrap gap-2">
        <ButtonLink to={paths.newMandate()} variant="outline">
          + New mandate
        </ButtonLink>
        {!r.savedCard && (
          <ButtonLink to={paths.offer(r.offerSlug)} variant="ghost">
            Save a card on an offer
          </ButtonLink>
        )}
      </div>
    </Section>
  );
}

/** The tools as the live server lists them; the static notes if the list can't load. */
function ToolList() {
  const live = useGet<McpToolListBody>('/api/mcp/tools', true);
  const tools: readonly Pick<McpToolInfo, 'name' | 'description' | 'scope'>[] =
    live.state.status === 'ready' ? live.state.data.tools : MCP_TOOL_DOCS;
  return (
    <Section title={buyerDeveloper.toolsTitle}>
      {live.state.status === 'loading' ? (
        <Skeleton className="h-40" />
      ) : (
        <ul className="-mt-1 flex flex-col divide-y divide-line">
          {tools.map((t) => (
            <li key={t.name} className="flex flex-col gap-1 py-4">
              <div className="flex flex-wrap items-center gap-2">
                <code className="font-mono text-[15px] text-ink">{t.name}</code>
                <Badge tone={t.scope === 'bid' ? 'held' : 'neutral'}>
                  {t.scope === 'bid' ? 'Bid' : 'Read'}
                </Badge>
              </div>
              <p className="text-[14px] leading-[21px] text-body">{firstSentence(t.description)}</p>
              {'inputSchema' in t && <ToolParams tool={t as McpToolInfo} />}
            </li>
          ))}
        </ul>
      )}
      <p className="text-[13px] text-muted">
        Amounts are integer US cents (21500 = $215.00). A Read-only token gets FORBIDDEN on bid
        tools; 30 calls a minute per token. Endpoint: {mcpEndpoint(window.location.origin)}
      </p>
    </Section>
  );
}

function ToolParams({ tool }: { tool: McpToolInfo }) {
  const names = Object.keys(tool.inputSchema.properties ?? {});
  if (names.length === 0) return null;
  return (
    <p className="font-mono text-[12px] text-muted">
      {'{ '}
      {names.join(', ')}
      {' }'}
    </p>
  );
}

/** The live descriptions are written for agents; the list shows their first sentence. */
export function firstSentence(text: string): string {
  const m = /^(.+?[.!?])(\s|$)/.exec(text.trim());
  return m ? m[1]! : text;
}

function Check({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span
        aria-hidden
        className={cn(
          'mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-[12px] font-medium',
          ok ? 'bg-success text-white' : 'border border-border text-muted',
        )}
      >
        {ok ? '✓' : ''}
      </span>
      <span className="text-[15px] text-ink">
        <span className="sr-only">{ok ? 'Done: ' : 'Not yet: '}</span>
        {children}
      </span>
    </li>
  );
}

function TokenRow({
  client,
  onRevoked,
}: {
  client: McpClientView;
  onRevoked(client: McpClientView): void;
}) {
  const revoke = useApiAction<McpClientRevokedBody>();
  const [confirming, setConfirming] = useState(false);
  const revoked = client.revokedAt !== null;

  const doRevoke = async () => {
    const body = await revoke.run({
      method: 'DELETE',
      path: `/api/mcp-clients/${encodeURIComponent(client.id)}`,
    });
    if (body) {
      setConfirming(false);
      onRevoked(body.client);
    }
  };

  return (
    <li
      className={cn(
        'flex flex-wrap items-center justify-between gap-3 py-4',
        revoked && 'text-muted',
      )}
    >
      <div className="min-w-0">
        <p className={cn('text-[16px]', revoked ? 'text-muted' : 'text-ink')}>
          {client.name}
          {client.scopes.includes('bid') ? '' : ' · read only'}
        </p>
        <p className="font-mono text-[12px] text-body">
          {client.tokenPrefix}… · created{' '}
          {new Date(client.createdAt).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
          })}
        </p>
      </div>
      <div className="flex items-center gap-4">
        <span
          className="font-mono text-[12px] text-muted tabular-nums"
          title={client.lastUsedAt ?? undefined}
        >
          {client.lastUsedAt
            ? `Used ${relativeTime(client.lastUsedAt).toLowerCase()}`
            : 'Never used'}
        </span>
        {revoked ? (
          <Badge tone="danger">Revoked</Badge>
        ) : confirming ? (
          <span className="inline-flex items-center gap-2">
            <Button variant="secondary" onClick={doRevoke} disabled={revoke.status === 'pending'}>
              {revoke.status === 'pending' ? '…' : 'Revoke now'}
            </Button>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Keep
            </Button>
          </span>
        ) : (
          <Button variant="ghost" onClick={() => setConfirming(true)}>
            Revoke
          </Button>
        )}
      </div>
      {revoke.status === 'error' && (
        <p role="alert" className="w-full text-[12px] text-danger">
          {revoke.error.message}
        </p>
      )}
    </li>
  );
}
