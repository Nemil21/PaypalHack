import { useCallback, useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import {
  type MandateListBody,
  type McpClientCreatedBody,
  type McpClientListBody,
  type McpClientRevokedBody,
  type McpClientView,
  type McpScope,
  type McpToolInfo,
} from '@holdfast/shared';
import {
  Badge,
  Button,
  ButtonLink,
  buttonClass,
  EmptyState,
  ErrorBanner,
  Skeleton,
  useToast,
} from '../components/ui';
import { ApiError, api } from '../lib/api';
import { clientConfig } from '../lib/client-config';
import { cn } from '../lib/cn';
import {
  claudeDesktopConfig,
  mandateSummary,
  mcpEndpoint,
  readiness,
  relativeTime,
  toolSignature,
  type Readiness,
} from '../lib/mcp-connect';
import { paths } from '../lib/routes';
import { useApiAction } from '../lib/use-api-action';
import { AccentHeading } from './auth/SignInLayout';

/**
 * W19 Developer / MCP connect (HF-043; screens.md §W19, features/07 §Logic 1). A signed-in
 * shopper creates a scoped token, copies it once, pastes the Claude Desktop config and sees
 * whether instant holds will work (readiness panel, M23). States: no tokens; token created
 * (one-time reveal); revoked. Sign-in on Render is the DEMO_MODE "Sign in as demo shopper" (D13).
 * v4 (Figma 115:184): setup and tokens on the left, mandates and the live tool list (the server's
 * own `tools/list` via `GET /api/mcp/tools`, plan §4.1 W19) on the right.
 */

interface Me {
  shopper: { id: string; email: string | null; provisional: boolean } | null;
}

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
        'flex min-w-0 flex-col gap-4 rounded-sm border border-line bg-white p-4 sm:p-5',
        className,
      )}
    >
      <h2 className="label text-[11px] text-muted">{title}</h2>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------

export function DeveloperPage() {
  const me = useGet<Me>('/api/me', true);
  const signedIn =
    me.state.status === 'ready' && !!me.state.data.shopper && !me.state.data.shopper.provisional;

  return (
    <>
      <header className="flex flex-col gap-5 pt-8 pb-8 sm:flex-row sm:items-end sm:justify-between lg:pt-14 lg:pb-10">
        <div className="flex max-w-[760px] flex-col gap-3">
          <span className="label text-[13px] text-orange">Developer · MCP</span>
          <AccentHeading
            heading={{ lead: 'Let your AI agent ', accent: 'bid for you.' }}
            className="text-[34px] leading-[1.08] font-medium tracking-headline text-ink sm:text-[44px] lg:text-[52px]"
          />
          <p className="text-[16px] leading-[25px] text-body">
            Connect Claude, or any MCP client, with a token scoped to your account. Bids it places
            use your own PayPal, under the limits you set.
          </p>
        </div>
        {signedIn && (
          <a href="#create-token" className={cn(buttonClass({}), 'self-start sm:self-auto')}>
            + Create token
          </a>
        )}
      </header>
      {me.state.status === 'loading' && <Skeleton className="h-40" />}
      {me.state.status === 'error' && (
        <ErrorBanner message={me.state.error.message} onRetry={me.reload} />
      )}
      {me.state.status === 'ready' && !signedIn && <SignIn onSignedIn={me.reload} />}
      {signedIn && me.state.status === 'ready' && <Connect email={me.state.data.shopper!.email} />}
    </>
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

function Connect({ email }: { email: string | null }) {
  const clients = useGet<McpClientListBody>('/api/mcp-clients', true);
  const mandates = useGet<MandateListBody>('/api/mandates', true);
  const [created, setCreated] = useState<McpClientCreatedBody | null>(null);
  const origin = window.location.origin;

  const onCreated = (body: McpClientCreatedBody) => {
    setCreated(body);
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
    <div className="grid grid-cols-1 gap-5 pb-16 lg:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-5">
        <ConfigSnippet origin={origin} token={created?.token ?? null} />
        {created ? (
          <Reveal created={created} onDone={() => setCreated(null)} />
        ) : (
          <CreateForm onCreated={onCreated} />
        )}
        <TokenTable state={clients.state} onRetry={clients.reload} onRevoked={onRevoked} />
        <Explainer email={email} />
      </div>
      <div className="flex min-w-0 flex-col gap-5">
        <MandatesCard state={mandates.state} onRetry={mandates.reload} />
        <ToolList />
      </div>
    </div>
  );
}

function Explainer({ email }: { email: string | null }) {
  return (
    <Section title="How it works">
      <ol className="flex list-decimal flex-col gap-2 pl-5 text-[15px] text-body">
        <li>
          Create a token below. Choose Read to let an agent look, Bid to let it place real holds.
        </li>
        <li>Paste the config into Claude Desktop and restart it.</li>
        <li>
          Ask: <span className="text-ink">"Put in a $215 bid for the Aurel A7s."</span> With a saved
          card and a mandate it's held at once; otherwise you get a link to approve it.
        </li>
      </ol>
      {email && (
        <p className="text-[13px] text-muted">
          Tokens act as <span className="text-ink">{email}</span>. Revoke one and it stops working
          immediately.
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
    <Section title="Create a token" className="scroll-mt-24" id="create-token">
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
      <pre className="overflow-x-auto rounded-sm bg-surface p-4 font-mono text-[12px] leading-[19px] text-ink">
        {snippet}
      </pre>
      <p className="text-[13px] text-body">
        Then try:{' '}
        <span className="text-ink">
          “Bid $229 on the Aurel A7, release it if a store goes under $249.”
        </span>
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" onClick={() => void copy(snippet, 'Config')}>
          Copy MCP setup
        </Button>
        <span className="font-mono text-[12px] text-muted">{mcpEndpoint(origin)}</span>
      </div>
    </Section>
  );
}

function TokenTable({
  state,
  onRetry,
  onRevoked,
}: {
  state: Load<McpClientListBody>;
  onRetry(): void;
  onRevoked(client: McpClientView): void;
}) {
  return (
    <Section title="Your tokens">
      {state.status === 'loading' && <Skeleton className="h-24" />}
      {state.status === 'error' && <ErrorBanner message={state.error.message} onRetry={onRetry} />}
      {state.status === 'ready' && state.data.clients.length === 0 && (
        <EmptyState message="No tokens yet. Create one above to connect an agent." />
      )}
      {state.status === 'ready' && state.data.clients.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[14px]">
            <thead>
              <tr className="border-b border-line text-[12px] text-muted">
                <th className="label py-2 pr-3 font-normal">Name</th>
                <th className="label hidden py-2 pr-3 font-normal sm:table-cell">Token</th>
                <th className="label py-2 pr-3 font-normal">Scopes</th>
                <th className="label py-2 pr-3 font-normal">Last used</th>
                <th className="py-2" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {state.data.clients.map((c) => (
                <TokenRow key={c.id} client={c} onRevoked={onRevoked} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
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
    <tr className={cn('border-b border-line align-middle', revoked && 'text-muted')}>
      <td className="py-3 pr-3">{client.name}</td>
      <td className="hidden py-3 pr-3 font-mono text-[12px] sm:table-cell">
        {client.tokenPrefix}…
      </td>
      <td className="py-3 pr-3">
        <div className="flex flex-wrap gap-1">
          {client.scopes.map((s) => (
            <Badge key={s} tone={s === 'bid' ? 'held' : 'neutral'}>
              {s === 'bid' ? 'Bid' : 'Read'}
            </Badge>
          ))}
        </div>
      </td>
      <td className="py-3 pr-3 tabular-nums" title={client.lastUsedAt ?? undefined}>
        {relativeTime(client.lastUsedAt)}
      </td>
      <td className="py-3 text-right">
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
          <Button variant="outline" onClick={() => setConfirming(true)}>
            Revoke
          </Button>
        )}
        {revoke.status === 'error' && (
          <p role="alert" className="mt-1 text-[12px] text-danger">
            {revoke.error.message}
          </p>
        )}
      </td>
    </tr>
  );
}

function ToolList() {
  const tools = useGet<{ tools: McpToolInfo[] }>('/api/mcp/tools', true);
  return (
    <Section title="Tools your agent gets">
      {tools.state.status === 'loading' && <Skeleton className="h-40" />}
      {tools.state.status === 'error' && (
        <ErrorBanner message={tools.state.error.message} onRetry={tools.reload} />
      )}
      {tools.state.status === 'ready' && (
        <ul className="flex flex-col divide-y divide-line border-t border-line">
          {tools.state.data.tools.map((t) => (
            <li key={t.name} className="flex flex-col gap-1.5 py-3.5 last:pb-0">
              <div className="flex flex-wrap items-center gap-2">
                <code className="font-mono text-[14px] text-ink">{t.name}</code>
                <Badge tone={t.scope === 'bid' ? 'held' : 'neutral'}>
                  {t.scope === 'bid' ? 'Bid' : 'Read'}
                </Badge>
              </div>
              <code className="font-mono text-[12px] break-words text-body">
                {toolSignature(t.params)}
              </code>
              {t.title && <p className="text-[14px] text-ink">{t.title}</p>}
              <details className="group text-[13px] leading-[20px] text-body">
                <summary className="label w-fit cursor-pointer text-[11px] text-muted hover:text-ink">
                  What the agent reads
                </summary>
                <p className="mt-1.5">{t.description}</p>
              </details>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[13px] text-muted">
        Live from the server’s tools/list. Amounts are integer US cents (21500 = $215.00). A
        Read-only token gets FORBIDDEN on bid tools; 30 calls a minute per token.
      </p>
    </Section>
  );
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

function MandatesCard({ state, onRetry }: { state: Load<MandateListBody>; onRetry(): void }) {
  if (state.status === 'loading') return <Skeleton className="h-48" />;
  if (state.status === 'error')
    return <ErrorBanner message={state.error.message} onRetry={onRetry} />;
  const r: Readiness = readiness(state.data);
  const live = state.data.mandates.filter((m) => m.state === 'active' || m.state === 'paused');
  return (
    <Section title="Mandates">
      <p className="text-[14px] leading-[21px] text-body">
        The limits your agent bids inside. The server enforces them, not the prompt.
      </p>
      {live.length > 0 && (
        <ul className="flex flex-col divide-y divide-line border-t border-line">
          {live.map((m) => {
            const sum = mandateSummary(m);
            return (
              <li key={m.mandateId} className="flex items-center justify-between gap-3 py-3">
                <Link to={paths.mandate(m.mandateId)} className="group min-w-0">
                  <span className="block text-[15px] text-ink group-hover:underline">
                    {sum.title}
                  </span>
                  <span className="block text-[13px] text-body">{sum.detail}</span>
                </Link>
                <Badge tone={m.state === 'active' ? 'success' : 'neutral'}>{m.state}</Badge>
              </li>
            );
          })}
        </ul>
      )}
      <ul className="flex flex-col gap-3 border-t border-line pt-4">
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
          <ButtonLink to={paths.offer(r.offerSlug)} variant="outline">
            Save a card on an offer
          </ButtonLink>
        )}
      </div>
    </Section>
  );
}
