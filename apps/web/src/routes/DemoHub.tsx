import { Link } from 'react-router';
import { PageHeader } from '../components/layout/AppShell';
import { Badge, ButtonLink } from '../components/ui';
import { clientConfig } from '../lib/client-config';
import { DEMO_OFFER_SLUG, paths } from '../lib/routes';

const README_TEST_ACCOUNTS = 'https://github.com/Nemil21/PaypalHack#test-accounts';

/**
 * `/demo` demo hub (HF-007). Reachable without login; points judges at the three ways in. The W01
 * landing page (HF-057) took over `/` and links here from its footer and hero.
 */
export function DemoHub() {
  const { demoMode } = clientConfig();
  const entries = [
    {
      n: '01',
      title: 'Brand console',
      body: 'Sign in as the demo brand and watch money already waiting on a listing.',
      to: paths.brandSignIn,
      cta: 'Demo sign-in',
      variant: 'secondary' as const,
    },
    {
      n: '02',
      title: 'Offer page',
      body: 'Place a PayPal hold at your price. Held, not charged.',
      to: paths.offer(DEMO_OFFER_SLUG),
      cta: 'Place a bid',
      variant: 'primary' as const,
    },
    {
      n: '03',
      title: 'Developer',
      body: 'Connect an agent over MCP and bid from Claude.',
      to: paths.developer,
      cta: 'Connect an agent',
      variant: 'outline' as const,
    },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Demo"
        title="Money that waits for the right price."
        lede="Holdfast turns “I’d buy it at $229” into a real PayPal hold, then lets the brand fill it privately. Pick a way in."
      />
      <ol className="grid grid-cols-1 border border-line md:grid-cols-3">
        {entries.map((e, i) => (
          <li
            key={e.n}
            className={i > 0 ? 'border-t border-line md:border-t-0 md:border-l' : undefined}
          >
            <div className="flex h-full flex-col gap-4 p-6 lg:p-8">
              <p className="label flex gap-2.5 text-[13px]">
                <span className="text-orange">{e.n}</span>
                <span className="text-ink">{e.title}</span>
              </p>
              <p className="flex-1 text-[17px] leading-[25px] text-body">{e.body}</p>
              <div>
                <ButtonLink to={e.to} variant={e.variant}>
                  {e.cta}
                </ButtonLink>
              </div>
            </div>
          </li>
        ))}
      </ol>
      <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
        <p className="text-[15px] text-body">
          Test accounts are in the{' '}
          <a className="text-ink underline underline-offset-4" href={README_TEST_ACCOUNTS}>
            README
          </a>
          .
        </p>
        {demoMode && <Badge tone="sim">Demo mode · PayPal sandbox</Badge>}
        <Link to={paths.devComponents} className="label text-[11px] text-muted hover:text-ink">
          Components →
        </Link>
      </div>
    </>
  );
}
