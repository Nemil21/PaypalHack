import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import lake896Avif from '../assets/landing/lake-896.avif';
import lake896Webp from '../assets/landing/lake-896.webp';
import lake1344Avif from '../assets/landing/lake-1344.avif';
import lake1344Webp from '../assets/landing/lake-1344.webp';
import lake1792Avif from '../assets/landing/lake-1792.avif';
import lake1792Webp from '../assets/landing/lake-1792.webp';
import { Button, ButtonLink } from '../components/ui';
import { cn } from '../lib/cn';
import {
  agents,
  comparison,
  compactUsd,
  DEMO_BOOK,
  DEMO_VIDEO_URL,
  GITHUB_URL,
  hero,
  PRIMARY_CTA,
  pricing,
  sponsors,
  steps,
  trust,
  youtubeEmbedUrl,
} from '../lib/landing';
import { paths } from '../lib/routes';

/**
 * W01 / M12 marketing landing (HF-057, features/18). Layout from Figma "Holdfast — v3" (D16):
 * white page, thin guide lines, square corners, Geist / Geist Mono labels, one orange action.
 * Static: no API calls, so it paints before anything else loads.
 */
export function Landing() {
  const [menu, setMenu] = useState(false);
  return (
    <div className="relative min-h-dvh overflow-x-clip pb-20 lg:pb-0">
      <Guides />
      <header className="relative z-20 mx-auto flex h-16 w-full max-w-[1440px] items-center justify-between gap-4 px-4 sm:px-8 lg:h-[88px] lg:px-18">
        <Link to={paths.home} className="text-[23px] font-semibold tracking-headline text-ink">
          Holdfast
        </Link>
        <nav aria-label="Main" className="hidden items-center gap-8 lg:flex">
          <NavLinks className="flex items-center gap-[30px]" />
          <div className="flex items-center gap-2">
            <ButtonLink to={paths.brandSignIn} variant="secondary">
              Sign in
            </ButtonLink>
            <ButtonLink to={PRIMARY_CTA.to}>{PRIMARY_CTA.label}</ButtonLink>
          </div>
        </nav>
        <div className="flex items-center gap-2 lg:hidden">
          <ButtonLink to={paths.brandSignIn} variant="outline">
            Sign in
          </ButtonLink>
          <button
            type="button"
            className="label h-9 rounded-sm border border-border px-3 text-[13px] text-charcoal"
            aria-expanded={menu}
            aria-controls="landing-menu"
            onClick={() => setMenu((m) => !m)}
          >
            {menu ? 'Close' : 'Menu'}
          </button>
        </div>
      </header>
      {menu && (
        <nav
          id="landing-menu"
          aria-label="Sections"
          className="relative z-20 border-y border-line bg-white px-4 py-2 sm:px-8 lg:hidden"
          onClick={() => setMenu(false)}
        >
          <NavLinks className="flex flex-col" itemClassName="block py-3 text-ink" />
        </nav>
      )}

      <main className="relative z-10 mx-auto w-full max-w-[1440px] px-4 sm:px-8 lg:px-18">
        <Hero />
        <HowItWorks />
        <Comparison />
        <Agents />
        <Trust />
        <Pricing />
      </main>
      <Footer />
      <StickyCta />
    </div>
  );
}

const sections = [
  { id: 'how-it-works', label: 'How it works' },
  { id: 'for-brands', label: 'For brands' },
  { id: 'for-agents', label: 'For agents' },
  { id: 'pricing', label: 'Pricing' },
];

function NavLinks({ className, itemClassName }: { className: string; itemClassName?: string }) {
  return (
    <ul className={className}>
      {sections.map((s) => (
        <li key={s.id}>
          <a
            href={`#${s.id}`}
            className={cn(
              'font-mono text-[13px] tracking-[0.02em] text-body hover:text-ink',
              itemClassName,
            )}
          >
            {s.label}
          </a>
        </li>
      ))}
    </ul>
  );
}

function Hero() {
  return (
    <section aria-labelledby="hero-title" className="pt-8 lg:pt-[82px]">
      <h1
        id="hero-title"
        className="max-w-[1100px] text-[36px] leading-[1.05] font-medium tracking-headline text-ink sm:text-[48px] lg:text-[64px]"
      >
        {hero.headline}
      </h1>
      <p className="mt-4 max-w-[1050px] text-[17px] leading-[25px] text-body sm:text-[21px] sm:leading-[30px] lg:mt-3 lg:text-[24px] lg:leading-[32px]">
        {hero.sub}
      </p>
      <div className="mt-7 flex flex-wrap items-center gap-2">
        <ButtonLink to={PRIMARY_CTA.to} size="lg">
          {PRIMARY_CTA.label}
        </ButtonLink>
        <DemoCta />
      </div>
      <HeroScene />
    </section>
  );
}

/** "Watch the 2-min demo" opens the video in a modal; until the video exists, the demo hub. */
function DemoCta() {
  const embed = DEMO_VIDEO_URL ? youtubeEmbedUrl(DEMO_VIDEO_URL) : null;
  const ref = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  if (!embed) {
    return (
      <ButtonLink to={paths.demo} size="lg" variant="outline">
        {hero.demoCta}
      </ButtonLink>
    );
  }
  return (
    <>
      <Button size="lg" variant="outline" onClick={() => setOpen(true)}>
        {hero.videoCta}
      </Button>
      <dialog
        ref={ref}
        aria-label="Holdfast demo video"
        onClose={() => setOpen(false)}
        className="m-auto w-[min(960px,92vw)] bg-ink p-0 backdrop:bg-ink/70"
      >
        <div className="flex justify-end p-2">
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Close
          </Button>
        </div>
        {/* The iframe only exists while open, so no YouTube request happens on page load. */}
        {open && (
          <iframe
            className="aspect-video w-full"
            src={embed}
            title="Holdfast in two minutes"
            allow="autoplay; encrypted-media; picture-in-picture"
            allowFullScreen
          />
        )}
      </dialog>
    </>
  );
}

const bars = [
  { price: 249, h: 24 },
  { price: 239, h: 39 },
  { price: 229, h: 67 },
  { price: 225, h: 81 },
  { price: 219, h: 100 },
  { price: 215, h: 60 },
  { price: 209, h: 44 },
  { price: 199, h: 31 },
];

/** The pixel-art lakeside warehouse with the brand console floating over it (W01 hero visual). */
function HeroScene() {
  const cutoff = DEMO_BOOK.cutoffCents / 100;
  return (
    <div className="relative mt-8 h-[440px] overflow-hidden bg-surface sm:h-[520px] lg:mt-10 lg:h-[580px]">
      <picture>
        <source
          type="image/avif"
          srcSet={`${lake896Avif} 896w, ${lake1344Avif} 1344w, ${lake1792Avif} 1792w`}
          sizes="(min-width: 1440px) 1296px, 100vw"
        />
        <img
          src={lake1344Webp}
          srcSet={`${lake896Webp} 896w, ${lake1344Webp} 1344w, ${lake1792Webp} 1792w`}
          sizes="(min-width: 1440px) 1296px, 100vw"
          width={1792}
          height={768}
          alt=""
          fetchPriority="high"
          decoding="async"
          className="absolute inset-0 h-full w-full object-cover object-[18%_center]"
        />
      </picture>
      <div className="absolute inset-0 flex items-center justify-center p-4 sm:justify-end sm:p-10 lg:pr-[120px]">
        <figure
          aria-label={`Brand console: ${compactUsd(DEMO_BOOK.heldCents)} held at or above $${cutoff}`}
          className="w-full max-w-[420px] bg-white/95 p-5 shadow-card sm:p-6"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="label text-[11px] text-body">Aurel A7 · held demand</p>
              <p className="mt-1 text-[32px] leading-none font-medium tracking-title text-ink tabular-nums">
                {compactUsd(DEMO_BOOK.heldCents)}
                <span className="mt-1 block text-[15px] font-normal text-body sm:mt-0 sm:ml-2 sm:inline">
                  held at ≥ ${cutoff}
                </span>
              </p>
            </div>
            <span className="label shrink-0 bg-orange-tint px-2 py-1 text-[10px] text-ink">
              Held, not charged
            </span>
          </div>
          <div aria-hidden className="relative mt-6 flex h-[120px] items-end gap-1.5">
            {bars.map((b) => (
              <div key={b.price} className="flex h-full flex-1 flex-col justify-end">
                <div
                  className={cn('w-full', b.price >= cutoff ? 'bg-charcoal' : 'bg-bar')}
                  style={{ height: `${b.h}%` }}
                />
              </div>
            ))}
          </div>
          <div aria-hidden className="mt-1.5 flex gap-1.5">
            {bars.map((b) => (
              <span key={b.price} className="flex-1 text-center font-mono text-[9px] text-body">
                ${b.price}
              </span>
            ))}
          </div>
          <div className="mt-4 flex items-center justify-between gap-3 border-t border-line pt-4">
            <p className="label text-[11px] text-body">
              Clear {DEMO_BOOK.quantity} · cutoff ${cutoff}
            </p>
            <span className="label bg-orange px-3 py-1.5 text-[11px] text-white" aria-hidden>
              Clear ↵
            </span>
          </div>
        </figure>
      </div>
    </div>
  );
}

function SectionHead({
  id,
  eyebrow,
  title,
  lede,
}: {
  id: string;
  eyebrow: string;
  title: string;
  lede?: string;
}) {
  return (
    <div className="flex flex-col gap-3">
      <p className="label text-[13px] text-orange">{eyebrow}</p>
      <h2
        id={id}
        className="max-w-[900px] text-[30px] leading-[1.1] font-medium tracking-headline text-ink sm:text-[40px] lg:text-[48px]"
      >
        {title}
      </h2>
      {lede && (
        <p className="max-w-[900px] text-[17px] leading-[25px] text-body sm:text-[21px] sm:leading-[30px]">
          {lede}
        </p>
      )}
    </div>
  );
}

function HowItWorks() {
  return (
    <section
      id="how-it-works"
      aria-labelledby="how-title"
      className="scroll-mt-4 border-t border-line pt-16 pb-16 mt-16 lg:mt-24 lg:pt-[104px]"
    >
      <SectionHead
        id="how-title"
        eyebrow="How it works"
        title="Money that waits for the right price."
        lede="Holdfast turns “I’d buy it at $229” into a real PayPal hold, then lets you fill it privately."
      />
      <ol className="mt-10 grid grid-cols-1 border border-line md:grid-cols-3 lg:mt-16">
        {steps.map((s, i) => (
          <li
            key={s.n}
            className={cn('p-6 lg:p-8', i > 0 && 'border-t border-line md:border-t-0 md:border-l')}
          >
            <h3 className="label flex gap-2.5 text-[13px]">
              <span className="text-orange">{s.n}</span>
              <span className="text-ink">{s.title}</span>
            </h3>
            <p className="mt-3 text-[17px] leading-[25px] text-body">{s.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Comparison() {
  const rows = comparison();
  return (
    <section
      id="for-brands"
      aria-labelledby="brands-title"
      className="scroll-mt-4 border-t border-line py-16 lg:py-24"
    >
      <SectionHead
        id="brands-title"
        eyebrow="For brands"
        title="Same 240 units. Four times the money."
        lede="A liquidator buys the pallet at a fraction of retail. Holdfast fills shoppers’ held bids instead, privately, so your public price never moves."
      />
      <dl className="mt-10 flex flex-col gap-6 lg:mt-14">
        {rows.map((r) => (
          <div
            key={r.label}
            className="grid grid-cols-1 gap-2 md:grid-cols-[200px_1fr] md:items-center md:gap-6"
          >
            <dt>
              <span className="label block text-[13px] text-ink">{r.label}</span>
              <span className="text-[14px] text-body">{r.detail}</span>
            </dt>
            <dd className="flex items-center gap-4">
              <div className="h-10 flex-1 bg-surface">
                <div
                  className={cn('h-full', r.tone === 'accent' ? 'bg-orange' : 'bg-bar')}
                  style={{ width: `${Math.round(r.share * 100)}%` }}
                />
              </div>
              <span className="w-[84px] text-right text-[24px] font-medium tracking-title text-ink tabular-nums">
                {compactUsd(r.cents)}
              </span>
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-6 text-[14px] text-body">
        Demo listing, net to the brand. Holdfast figure is after the 9% fee; a winner never pays
        more than their own bid.
      </p>
    </section>
  );
}

function Agents() {
  return (
    <section
      id="for-agents"
      aria-labelledby="agents-title"
      className="scroll-mt-4 border-t border-line py-16 lg:py-24"
    >
      <div className="grid grid-cols-1 gap-10 lg:grid-cols-2 lg:gap-16">
        <div>
          <SectionHead id="agents-title" eyebrow="For agents · MCP" title={agents.title} />
          <p className="mt-4 text-[17px] leading-[25px] text-body">{agents.body}</p>
          <p className="mt-6 border-l-2 border-orange pl-4 text-[17px] leading-[25px] text-ink">
            {agents.prompt}
          </p>
          <div className="mt-8">
            <ButtonLink to={paths.developer} variant="outline">
              Connect an agent
            </ButtonLink>
          </div>
        </div>
        <figure className="min-w-0 border border-line bg-surface">
          <figcaption className="label border-b border-line px-4 py-3 text-[11px] text-body">
            claude_desktop_config.json
          </figcaption>
          <pre className="overflow-x-auto p-4 font-mono text-[12px] leading-[19px] text-ink sm:text-[13px]">
            <code>{agents.snippet}</code>
          </pre>
        </figure>
      </div>
    </section>
  );
}

function Trust() {
  return (
    <section aria-labelledby="trust-title" className="border-t border-line py-16 lg:py-24">
      <SectionHead id="trust-title" eyebrow="Trust" title="Real money, real limits." />
      <ul className="mt-10 grid grid-cols-1 border border-line sm:grid-cols-2 lg:mt-14 lg:grid-cols-5">
        {trust.map((t) => (
          <li key={t.title} className="-mt-px -ml-px border-t border-l border-line p-6">
            <h3 className="label flex items-center gap-2 text-[12px] text-ink">
              <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-orange" />
              {t.title}
            </h3>
            <p className="mt-3 text-[15px] leading-[22px] text-body">{t.body}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Pricing() {
  return (
    <section
      id="pricing"
      aria-labelledby="pricing-title"
      className="scroll-mt-4 border-t border-line py-16 lg:py-24"
    >
      <div className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex flex-col gap-3">
          <p className="label text-[13px] text-orange">Pricing</p>
          <h2
            id="pricing-title"
            className="text-[44px] leading-none font-medium tracking-headline text-ink sm:text-[64px] lg:text-[88px]"
          >
            {pricing.headline}
          </h2>
          <p className="text-[17px] leading-[25px] text-body sm:text-[21px] sm:leading-[30px]">
            {pricing.sub}
          </p>
        </div>
        <div>
          <ButtonLink to={PRIMARY_CTA.to} size="lg">
            {PRIMARY_CTA.label}
          </ButtonLink>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="relative z-10 mx-auto w-full max-w-[1440px] px-4 sm:px-8 lg:px-18">
      <div className="flex flex-col gap-6 border-t border-line py-10 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex flex-col gap-2">
          <span className="text-[19px] font-semibold tracking-headline text-ink">Holdfast</span>
          <p className="max-w-[420px] text-[14px] leading-[21px] text-body">
            Built for the PayPal AI Hackathon 2026. Runs on the PayPal sandbox; no real money moves.
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <p className="label text-[11px] text-body">Built with</p>
          <ul className="flex flex-wrap gap-x-5 gap-y-1 text-[14px] text-ink">
            {sponsors.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </div>
        <ul className="flex flex-wrap gap-x-5 gap-y-2 font-mono text-[13px]">
          <li>
            <a href={GITHUB_URL} className="text-ink underline underline-offset-4">
              GitHub · MIT license
            </a>
          </li>
          <li>
            <Link to={paths.demo} className="text-ink underline underline-offset-4">
              Demo hub
            </Link>
          </li>
          <li>
            <Link to={paths.developer} className="text-ink underline underline-offset-4">
              Developers
            </Link>
          </li>
        </ul>
      </div>
    </footer>
  );
}

/** M12: the primary CTA stays in reach on phones. */
function StickyCta() {
  return (
    <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-white/95 p-3 lg:hidden">
      <ButtonLink to={PRIMARY_CTA.to} size="lg" block>
        {PRIMARY_CTA.label}
      </ButtonLink>
    </div>
  );
}

/** The v3 thin vertical guide lines, 48 px in from the content column's edges. */
function Guides() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 hidden lg:block">
      <div className="relative mx-auto h-full max-w-[1440px]">
        <span className="absolute inset-y-0 left-12 w-px bg-line" />
        <span className="absolute inset-y-0 right-12 w-px bg-line" />
      </div>
    </div>
  );
}
