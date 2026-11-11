import { lazy, Suspense, useState, type ReactNode } from 'react';
import {
  AFFILIATE_DISCLOSURE,
  moneyLine,
  releasedHoldMessage,
  winnersChargedSummary,
  wonMessage,
} from '@holdfast/shared';
import { PageHeader } from '../components/layout/AppShell';
import {
  Badge,
  Button,
  EmptyState,
  ErrorBanner,
  Skeleton,
  StatTile,
  SimChip,
  useToast,
} from '../components/ui';
import { clientConfig } from '../lib/client-config';
import { useListingEvents } from '../lib/listing-events';
import { color, radius, space } from '../lib/tokens';

const DemoBidsGrid = lazy(() => import('../components/ag/DemoBidsGrid'));
const DemoDemandChart = lazy(() => import('../components/ag/DemoDemandChart'));
const DemoStudioKpis = lazy(() => import('../components/ag/DemoStudioKpis'));

/** `/dev/components`: every base component and state, the v3 tokens, and the AG licence check. */
export function DevComponents() {
  return (
    <>
      <PageHeader
        eyebrow="/dev/components"
        title="Components"
        lede="Holdfast v3 tokens and base components, with the AG Grid, AG Charts and AG Studio licence check."
      />
      <div className="flex flex-col gap-12">
        <Tokens />
        <Buttons />
        <Badges />
        <StatTiles />
        <States />
        <Toasts />
        <MoneyCopy />
        <LiveEvents />
        <AgLicence />
      </div>
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4 border-t border-line pt-6">
      <h2 className="label text-[13px] text-ink">{title}</h2>
      {children}
    </section>
  );
}

function Tokens() {
  return (
    <Section title="Tokens (Figma · Holdfast — v3)">
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
        {Object.entries(color).map(([name, hex]) => (
          <li key={name} className="flex items-center gap-2 text-[13px]">
            <span
              className="size-8 shrink-0 rounded-sm border border-line"
              style={{ background: hex }}
            />
            <span className="min-w-0">
              <span className="block truncate text-ink">{name}</span>
              <span className="font-mono text-[11px] text-muted uppercase">{hex}</span>
            </span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-end gap-3">
        {Object.entries(space).map(([k, px]) => (
          <span key={k} className="flex flex-col items-center gap-1">
            <span className="block bg-orange" style={{ width: px, height: px }} />
            <span className="font-mono text-[11px] text-muted">{px}</span>
          </span>
        ))}
        <span className="font-mono text-[11px] text-muted">
          · radius {radius.sm}/{radius.md}px
        </span>
      </div>
      <div className="flex flex-col gap-2">
        <p className="text-[34px] leading-tight font-medium tracking-headline sm:text-[56px]">
          Geist headline $229
        </p>
        <p className="text-[17px] leading-[25px] text-body">
          Geist body. Your agent puts a PayPal hold at your price. Held, not charged.
        </p>
        <p className="label text-[13px] text-muted">Geist Mono label · paypal auth · 72h window</p>
      </div>
    </Section>
  );
}

function Buttons() {
  const [pending, setPending] = useState(false);
  return (
    <Section title="Button">
      <div className="flex flex-wrap gap-2">
        <Button shortcut="P">Place a bid</Button>
        <Button variant="secondary" shortcut="B">
          For brands
        </Button>
        <Button variant="outline">Copy MCP setup</Button>
        <Button variant="ghost">Cancel</Button>
        <Button disabled>Disabled</Button>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="lg" shortcut="G">
          Start bidding free
        </Button>
        <Button
          size="lg"
          disabled={pending}
          onClick={() => {
            setPending(true);
            setTimeout(() => setPending(false), 1500);
          }}
        >
          {pending ? 'Holding…' : 'Hold $229 with PayPal'}
        </Button>
      </div>
      <div className="max-w-sm">
        <Button block size="lg">
          Full width (mobile sticky bar)
        </Button>
      </div>
    </Section>
  );
}

function Badges() {
  return (
    <Section title="Badge">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="held">Held · not charged</Badge>
        <Badge tone="success">Charged</Badge>
        <Badge tone="neutral">Released</Badge>
        <Badge tone="dark">Won</Badge>
        <Badge tone="danger">Hold failed</Badge>
        <SimChip />
      </div>
    </Section>
  );
}

function StatTiles() {
  return (
    <Section title="Stat tile">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Money held" value="$61,240" emphasis caption="≥ $219 cutoff" />
        <StatTile label="Live holds" value="82" caption="12 SIM" />
        <StatTile label="Average bid" value="$226" />
        <StatTile label="Loading" value={undefined} caption="Skeleton, never a spinner" />
      </div>
    </Section>
  );
}

function States() {
  const [retrying, setRetrying] = useState(false);
  return (
    <Section title="Loading · error · empty">
      <div className="flex max-w-md flex-col gap-2 rounded-md border border-line p-4">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-[34px] w-28" />
        <Skeleton className="h-3 w-36" />
      </div>
      <ErrorBanner
        message="We couldn't load the book."
        retrying={retrying}
        onRetry={() => {
          setRetrying(true);
          setTimeout(() => setRetrying(false), 1200);
        }}
      />
      <EmptyState
        message="No bids yet. Share the offer link to start collecting holds."
        action={<Button variant="outline">Copy offer link</Button>}
      />
    </Section>
  );
}

function Toasts() {
  const toast = useToast();
  return (
    <Section title="Toast">
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          onClick={() =>
            toast.show({ title: 'New hold: $229', body: 'Shopper #241 via MCP', tone: 'info' })
          }
        >
          Info
        </Button>
        <Button
          variant="outline"
          onClick={() => toast.show({ title: 'Charged $229', tone: 'success' })}
        >
          Success
        </Button>
        <Button
          variant="outline"
          onClick={() =>
            toast.show({
              title: "PayPal couldn't hold $229.",
              body: 'Try another method.',
              tone: 'error',
            })
          }
        >
          Error
        </Button>
      </div>
    </Section>
  );
}

function MoneyCopy() {
  const lines = [
    moneyLine('HELD', 22_900),
    moneyLine('CAPTURED', 22_900),
    moneyLine('VOIDED', 24_900),
    moneyLine('CAPTURE_FAILED', 22_900),
    wonMessage(22_900, { captured: false }),
    wonMessage(22_900, { captured: true }),
    winnersChargedSummary([21_900, 22_500, 22_900, 23_100]),
    releasedHoldMessage(24_900),
    AFFILIATE_DISCLOSURE,
  ];
  return (
    <Section title="Money copy (D14)">
      <ul className="flex flex-col gap-1 text-[15px] text-body">
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </Section>
  );
}

function LiveEvents() {
  const [count, setCount] = useState(0);
  const status = useListingEvents('demo', () => setCount((c) => c + 1));
  return (
    <Section title="useListingEvents">
      <p className="text-[15px] text-body">
        Stream <code className="font-mono text-[13px]">/api/listings/demo/events</code>:{' '}
        <Badge tone={status === 'open' ? 'success' : 'neutral'}>{status}</Badge> · {count} events.
        The stream itself ships with HF-008; until then it reports closed.
      </p>
    </Section>
  );
}

function AgLicence() {
  const licensed = !!clientConfig().agGridLicenseKey;
  return (
    <Section title="AG Grid · AG Charts · AG Studio">
      <p className="text-[15px] text-body">
        Licence key:{' '}
        <Badge tone={licensed ? 'success' : 'danger'}>
          {licensed ? 'Loaded' : 'Missing: set AG_GRID_LICENSE_KEY'}
        </Badge>{' '}
        AG Studio always uses the key. The grid and chart use Enterprise only when the key covers AG
        Grid Enterprise, otherwise Community. AG hides its watermark on localhost: open{' '}
        <a className="text-ink underline underline-offset-4" href="/dev/components/forceWatermark">
          /dev/components/forceWatermark
        </a>{' '}
        to see what production shows.
      </p>
      <Suspense fallback={<Skeleton className="h-[420px] w-full" />}>
        <h3 className="label text-[11px] text-muted">AG Grid Enterprise</h3>
        <DemoBidsGrid />
        <h3 className="label text-[11px] text-muted">AG Charts Enterprise</h3>
        <DemoDemandChart />
        <h3 className="label text-[11px] text-muted">AG Studio</h3>
        <DemoStudioKpis />
      </Suspense>
    </Section>
  );
}
