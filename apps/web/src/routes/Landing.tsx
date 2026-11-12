import { useEffect, useRef, useState, type MouseEvent, type ReactNode, type SVGProps } from 'react';
import { Link } from 'react-router';
import desert960Avif from '../assets/landing/desert-960.avif';
import desert960Webp from '../assets/landing/desert-960.webp';
import desert1600Avif from '../assets/landing/desert-1600.avif';
import desert1600Webp from '../assets/landing/desert-1600.webp';
import meadow960Avif from '../assets/landing/meadow-960.avif';
import meadow960Webp from '../assets/landing/meadow-960.webp';
import meadow1600Avif from '../assets/landing/meadow-1600.avif';
import meadow1600Webp from '../assets/landing/meadow-1600.webp';
import lake896Avif from '../assets/landing/lake-896.avif';
import lake896Webp from '../assets/landing/lake-896.webp';
import lake1344Avif from '../assets/landing/lake-1344.avif';
import lake1344Webp from '../assets/landing/lake-1344.webp';
import lake1792Avif from '../assets/landing/lake-1792.avif';
import lake1792Webp from '../assets/landing/lake-1792.webp';
import {
  ClaudeLogo,
  GitHubLogo,
  LinkedInLogo,
  OpenAILogo,
  OpenCodeLogo,
  SPONSOR_LOGOS,
  YouTubeLogo,
} from '../components/logos';
import { Button, ButtonLink, buttonClass, useToast } from '../components/ui';
import { cn } from '../lib/cn';
import {
  type AgentClient,
  agents,
  agentSnippets,
  brands,
  comparison,
  type ComparisonRow,
  compactUsd,
  DEMO_VIDEO_URL,
  footer,
  GITHUB_URL,
  hero,
  heroChat,
  how,
  mcpPrompt,
  multiple,
  nav,
  pricing,
  sponsors,
  steps,
  youtubeEmbedUrl,
} from '../lib/landing';
import { paths } from '../lib/routes';
import './landing.css';

/**
 * W01 / M12 marketing landing (HF-057, features/18), v4 layout (Figma "Holdfast — v3" → `101:4`):
 * white page, thin guide lines, square corners, Geist / Geist Mono labels, one orange action,
 * orange serif italic accent words. Static: no API calls, so it paints before anything else loads.
 * Motion follows frame `105:186` in CSS only (`landing.css`), off under prefers-reduced-motion.
 */
export function Landing() {
  const [menu, setMenu] = useState(false);
  const scrolled = useScrolled(8);
  const [pulse, setPulse] = useState(0);
  const toContact = (e: MouseEvent) => {
    e.preventDefault();
    setMenu(false);
    document.getElementById('contact')?.scrollIntoView({
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
    // The LinkedIn card pulses once on arrival (motion spec, "Contact us").
    setPulse((n) => n + 1);
  };
  return (
    <div className="relative min-h-dvh overflow-x-clip pb-20 lg:pb-0">
      <Guides />
      <header
        className={cn(
          'sticky top-0 z-30 border-b transition-[background-color,border-color] duration-200',
          scrolled || menu
            ? 'border-line bg-white/90 backdrop-blur-md'
            : 'border-transparent bg-transparent',
        )}
      >
        <div className={cn(column, 'flex h-16 items-center justify-between gap-4 lg:h-[72px]')}>
          <Link to={paths.home} className="text-[23px] font-semibold tracking-headline text-ink">
            Holdfast
          </Link>
          <nav aria-label="Main" className="hidden items-center gap-8 lg:flex">
            <NavLinks className="flex items-center gap-[30px]" />
            <div className="flex items-center gap-2">
              <ButtonLink to={nav.signIn.to} variant="outline" className="border-ink text-ink">
                {nav.signIn.label}
              </ButtonLink>
              <a href={nav.contact.href} onClick={toContact} className={buttonClass({})}>
                {nav.contact.label}
              </a>
            </div>
          </nav>
          <div className="flex items-center gap-2 lg:hidden">
            <ButtonLink to={nav.signIn.to} variant="outline">
              {nav.signIn.label}
            </ButtonLink>
            <button
              type="button"
              className="label h-9 rounded-sm border border-border bg-white px-3 text-[13px] text-charcoal"
              aria-expanded={menu}
              aria-controls="landing-menu"
              onClick={() => setMenu((m) => !m)}
            >
              {menu ? 'Close' : 'Menu'}
            </button>
          </div>
        </div>
        {menu && (
          <nav
            id="landing-menu"
            aria-label="Sections"
            className="border-t border-line bg-white px-4 py-2 sm:px-8 lg:hidden"
            onClick={() => setMenu(false)}
          >
            <NavLinks className="flex flex-col" itemClassName="block py-3 text-ink" />
          </nav>
        )}
      </header>

      <main className={cn(column, 'relative z-10')}>
        <Hero />
        <HowItWorks />
        <Comparison />
        <Agents />
        <Pricing />
      </main>
      <Footer pulse={pulse} />
      <StickyCta onContact={toContact} />
    </div>
  );
}

/** v4 content column: 1120 px inside 160 px margins at 1440, 16 px gutters on phones. */
const column = 'mx-auto w-full max-w-[1440px] px-4 sm:px-8 lg:px-16 xl:px-[160px]';

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** True once the page has scrolled past `threshold` px (nav turns white/90 + blur + hairline). */
function useScrolled(threshold: number): boolean {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > threshold);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [threshold]);
  return scrolled;
}

/** The section in view, for the nav's active underline. */
function useActiveSection(ids: readonly string[]): string | null {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setActive(e.target.id);
      },
      { rootMargin: '-45% 0px -50% 0px' },
    );
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, [ids]);
  return active;
}

/**
 * Adds `hf-in` once the element is a quarter into view, so `landing.css` plays its enter motion
 * once. Without IntersectionObserver it is in view at once (final state).
 */
function useReveal<T extends Element>() {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver(
      ([e]) => {
        if (e?.isIntersecting) {
          setInView(true);
          io.disconnect();
        }
      },
      { threshold: 0.25 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [ref, inView ? 'hf-in' : ''] as const;
}

const sectionIds = nav.sections.map((s) => s.id);

/** Body → ink plus a 1.5 px underline that wipes in left → right (180 ms). */
const navLink =
  'hf-wipe font-mono text-[13px] tracking-[0.02em] text-body hover:text-ink aria-[current=true]:text-ink';

function NavLinks({ className, itemClassName }: { className: string; itemClassName?: string }) {
  const active = useActiveSection(sectionIds);
  return (
    <ul className={className}>
      {nav.sections.map((s) => (
        <li key={s.id}>
          <a
            href={`#${s.id}`}
            aria-current={active === s.id ? 'true' : undefined}
            className={cn(navLink, itemClassName)}
          >
            {s.label}
          </a>
        </li>
      ))}
      <li>
        <Link to={nav.docs.to} className={cn(navLink, itemClassName)}>
          {nav.docs.label}
        </Link>
      </li>
    </ul>
  );
}

/** Orange-tint marker bar behind words; draws in left → right (600 ms). */
function Marker({ children }: { children: ReactNode }) {
  return <span className="hf-marker">{children}</span>;
}

function Hero() {
  return (
    <section aria-labelledby="hero-title" className="pt-8 lg:pt-[72px]">
      <h1
        id="hero-title"
        className="max-w-[900px] text-[36px] leading-[1.08] font-medium tracking-headline text-ink sm:text-[48px] lg:text-[64px]"
      >
        {hero.headlineLead}
        <Marker>{hero.headlineAccent}</Marker>.
      </h1>
      <p className="mt-5 max-w-[760px] text-[17px] leading-[25px] text-body sm:text-[20px] sm:leading-[30px]">
        {hero.sub}
      </p>
      <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
        <CopyPromptButton />
        <DemoCta variant="link" />
      </div>
      <HeroScene />
    </section>
  );
}

/** Dark "Copy MCP prompt" with the client logos chip; the copy icon morphs to a check. */
function CopyPromptButton() {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(mcpPrompt(window.location.origin));
      setCopied(true);
      toast.show({ title: hero.copied, body: hero.copiedBody, tone: 'success', duration: 2500 });
    } catch {
      toast.show({ title: 'Couldn’t copy', body: 'Open Developers for the setup.', tone: 'error' });
    }
  };
  return (
    <button
      type="button"
      onClick={copy}
      className="label inline-flex h-12 items-center gap-3 rounded-sm bg-ink pr-1.5 pl-4 text-[13px] text-white transition-colors hover:bg-charcoal"
    >
      <span className="relative size-4" aria-hidden>
        <CopyIcon className={cn('hf-swap absolute inset-0', copied && 'opacity-0 scale-50')} />
        <CheckIcon
          className={cn('hf-swap absolute inset-0 text-orange', !copied && 'opacity-0 scale-50')}
        />
      </span>
      <span aria-live="polite">{copied ? hero.copied : hero.copyCta}</span>
      <span className="flex h-9 items-center gap-2 rounded-[2px] bg-white px-2.5" aria-hidden>
        <ClaudeLogo className="size-4" />
        <OpenAILogo className="size-4 text-ink" />
        <OpenCodeLogo className="size-4 text-ink" />
      </span>
    </button>
  );
}

function CopyIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className={className}
    >
      <rect x="5" y="5" width="9" height="9" rx="1" />
      <path d="M11 5V3a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h2" />
    </svg>
  );
}

function CheckIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden
      {...props}
    >
      <path d="m3 8.5 3 3 7-7" />
    </svg>
  );
}

/**
 * "Watch the 2-min demo" opens the video in a modal; until the video exists (DEMO_VIDEO_URL is
 * null), it links to the interactive demo hub instead. `link` is the hero text link, `button`
 * the outlined Pricing CTA.
 */
function DemoCta({ variant, label }: { variant: 'link' | 'button'; label?: string }) {
  const embed = DEMO_VIDEO_URL ? youtubeEmbedUrl(DEMO_VIDEO_URL) : null;
  const ref = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  const cls =
    variant === 'link'
      ? 'inline-flex items-center gap-2.5 font-mono text-[13px] text-ink underline decoration-[1.5px] underline-offset-[6px] hover:text-orange'
      : cn(buttonClass({ variant: 'outline', size: 'lg' }), 'border-[1.5px] border-ink text-ink');

  if (!embed) {
    return (
      <Link to={paths.demo} className={cls}>
        {hero.demoCta}
      </Link>
    );
  }
  return (
    <>
      <button type="button" className={cls} onClick={() => setOpen(true)}>
        <YouTubeLogo className="h-4 w-[22px]" />
        {label ?? hero.videoCta}
      </button>
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

/**
 * Types `text` at 35 ms a character once `start` is true (motion spec, Hero). Under reduced motion,
 * or without timers, the full text shows at once.
 */
function useTyped(text: string, start: boolean): string {
  const [n, setN] = useState(() => (prefersReducedMotion() ? text.length : 0));
  useEffect(() => {
    if (!start || n >= text.length) return;
    const t = setTimeout(() => setN((c) => c + 1), 35);
    return () => clearTimeout(t);
  }, [start, n, text.length]);
  return text.slice(0, n);
}

/** The lakeside warehouse with a shopper's agent prompt over it (v4 hero visual, `101:69`). */
function HeroScene() {
  const [ref, reveal] = useReveal<HTMLDivElement>();
  const typed = useTyped(heroChat.prompt, reveal !== '');
  const done = typed.length === heroChat.prompt.length;
  return (
    <div
      ref={ref}
      className={cn(
        'relative mt-10 h-[440px] overflow-hidden rounded-sm bg-surface sm:h-[520px] lg:mt-12 lg:h-[600px]',
        reveal,
      )}
    >
      <picture>
        <source
          type="image/avif"
          srcSet={`${lake896Avif} 896w, ${lake1344Avif} 1344w, ${lake1792Avif} 1792w`}
          sizes="(min-width: 1440px) 1120px, 100vw"
        />
        <img
          src={lake1344Webp}
          srcSet={`${lake896Webp} 896w, ${lake1344Webp} 1344w, ${lake1792Webp} 1792w`}
          sizes="(min-width: 1440px) 1120px, 100vw"
          width={1792}
          height={768}
          alt=""
          fetchPriority="high"
          decoding="async"
          className="absolute inset-0 h-full w-full object-cover object-[18%_center]"
        />
      </picture>
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-4">
        <figure
          aria-label={`A shopper’s agent prompt: “${heroChat.prompt}”, ceiling ${heroChat.ceiling}, window ${heroChat.window}`}
          className="flex w-full max-w-[600px] flex-col items-center gap-3"
        >
          <ul
            aria-hidden
            className="flex gap-0.5 rounded-sm bg-white/90 p-1 font-mono text-[12px] text-body shadow-card sm:text-[14px]"
          >
            {heroChat.modes.map((m) => (
              <li
                key={m}
                className={cn(
                  'rounded-[2px] px-3 py-1.5 sm:px-4',
                  m === heroChat.active && 'bg-surface-rule font-medium text-ink',
                )}
              >
                {m}
              </li>
            ))}
          </ul>
          <div aria-hidden className="w-full rounded-sm bg-white/95 p-4 shadow-card sm:px-5">
            <p className="flex min-h-[44px] items-start gap-3 text-[14px] leading-[22px] text-ink sm:min-h-0 sm:text-[16px]">
              <LockIcon className="mt-[3px] size-4 shrink-0 text-muted" />
              <span>
                {typed}
                <span className="hf-caret ml-0.5 inline-block h-[1.1em] w-px translate-y-[3px] bg-ink" />
              </span>
            </p>
            <div className="mt-4 flex items-center justify-between gap-3">
              <p className="flex flex-wrap gap-x-5 gap-y-1 text-[13px] text-body sm:text-[14px]">
                <span>
                  Ceiling <span className="text-ink">{heroChat.ceiling}</span> ⌄
                </span>
                <span>
                  Window <span className="text-ink">{heroChat.window}</span> ⌄
                </span>
              </p>
              <span
                className={cn(
                  'label shrink-0 rounded-[2px] bg-orange px-3 py-1.5 text-[12px] text-white',
                  done && 'hf-press',
                )}
              >
                {heroChat.submit} ↵
              </span>
            </div>
          </div>
        </figure>
      </div>
    </div>
  );
}

function LockIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden
      className={className}
    >
      <rect x="3" y="7" width="10" height="7" rx="1" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  );
}

/** Orange Instrument Serif Italic accent word(s). */
function Accent({ children }: { children: ReactNode }) {
  return (
    <span className="font-serif text-[1.08em] font-normal tracking-normal text-orange italic">
      {children}
    </span>
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
  title: ReactNode;
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
        <p className="max-w-[720px] text-[17px] leading-[26px] text-body sm:text-[19px] sm:leading-[29px]">
          {lede}
        </p>
      )}
    </div>
  );
}

function HowItWorks() {
  const [ref, reveal] = useReveal<HTMLOListElement>();
  return (
    <section
      id="how-it-works"
      aria-labelledby="how-title"
      className="mt-16 scroll-mt-20 border-t border-line pt-16 pb-16 lg:mt-24 lg:pt-[104px] lg:pb-24"
    >
      <SectionHead
        id="how-title"
        eyebrow="How it works"
        title={
          <>
            {how.lead}
            <Accent>{how.accent}</Accent>
          </>
        }
      />
      <ol
        ref={ref}
        className={cn(
          'mt-10 grid grid-cols-1 gap-10 md:grid-cols-3 md:gap-[70px] lg:mt-14',
          reveal,
        )}
      >
        {steps.map((s, i) => (
          <li key={s.n} className="relative">
            <span aria-hidden className="hf-rule block h-px bg-ink" />
            <p className="mt-8 font-mono text-[12px] text-orange">{s.n}</p>
            <h3 className="mt-3 text-[30px] leading-[1.1] font-medium tracking-headline text-ink lg:text-[40px]">
              {s.lead}{' '}
              <span className="hf-rise inline-block" style={{ animationDelay: `${i * 150}ms` }}>
                <Accent>{s.accent}</Accent>
              </span>
            </h3>
            <p className="mt-3 max-w-[280px] text-[15px] leading-[23px] text-body">{s.body}</p>
            <span className="label mt-4 inline-block rounded-[2px] bg-orange-key px-2 py-1 text-[10px] text-ink">
              {s.chip}
            </span>
            {i < steps.length - 1 && (
              <span
                aria-hidden
                className="hf-nudge absolute top-[88px] -right-[48px] hidden text-[28px] leading-none text-orange md:block lg:top-[94px]"
                style={{ animationDelay: `${450 + i * 150}ms` }}
              >
                →
              </span>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Counts up to `cents` (compact, "$49.4k") once `start` is true; final value under reduced motion. */
function useCountUp(cents: number, start: boolean): number {
  const [v, setV] = useState(() => (prefersReducedMotion() ? cents : 0));
  useEffect(() => {
    if (!start || prefersReducedMotion() || typeof requestAnimationFrame === 'undefined') {
      if (start) setV(cents);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / 900);
      setV(Math.round(cents * (1 - (1 - k) ** 3)));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [cents, start]);
  return v;
}

function Comparison() {
  const [liquidator, holdfast] = comparison() as [ComparisonRow, ComparisonRow];
  const [ref, reveal] = useReveal<HTMLDivElement>();
  const liq = useCountUp(liquidator.cents, reveal !== '');
  const hf = useCountUp(holdfast.cents, reveal !== '');
  return (
    <section
      id="for-brands"
      aria-labelledby="brands-title"
      className="scroll-mt-20 border-t border-line py-16 lg:py-24"
    >
      <SectionHead id="brands-title" eyebrow="For brands" title={brands.title} lede={brands.lede} />
      <div
        ref={ref}
        className={cn('relative mt-10 grid grid-cols-1 gap-5 md:grid-cols-2 lg:mt-14', reveal)}
      >
        <PhotoCard
          row={liquidator}
          shown={liq}
          image={
            <picture>
              <source type="image/avif" srcSet={`${lake896Avif} 896w`} />
              <img
                src={lake896Webp}
                width={896}
                height={384}
                alt=""
                loading="lazy"
                decoding="async"
                className="h-full w-full object-cover object-[12%_center] grayscale"
              />
            </picture>
          }
          tag={
            <span className="label bg-ink px-2 py-1 text-[10px] text-white">
              {liquidator.label}
            </span>
          }
        />
        <PhotoCard
          row={holdfast}
          shown={hf}
          accent
          image={
            <picture>
              <source
                type="image/avif"
                srcSet={`${meadow960Avif} 960w, ${meadow1600Avif} 1600w`}
                sizes="(min-width: 768px) 50vw, 100vw"
              />
              <img
                src={meadow960Webp}
                srcSet={`${meadow960Webp} 960w, ${meadow1600Webp} 1600w`}
                sizes="(min-width: 768px) 50vw, 100vw"
                width={1600}
                height={900}
                alt=""
                loading="lazy"
                decoding="async"
                className="h-full w-full object-cover"
              />
            </picture>
          }
          tag={
            <span className="label bg-orange px-2 py-1 text-[10px] text-white">
              {holdfast.label}
            </span>
          }
          overlay={
            <ul
              aria-hidden
              className="absolute top-12 right-4 flex flex-col items-end gap-2.5 sm:right-[18%]"
            >
              {brands.chips.map((c, i) => (
                <li
                  key={c}
                  className={cn(
                    'hf-float flex items-center gap-2 rounded-[2px] bg-white px-2.5 py-1.5 font-mono text-[11px] text-ink shadow-card',
                    i % 2 === 1 && 'mr-0 sm:-mr-9',
                  )}
                  style={{ animationDelay: `${i * 180}ms` }}
                >
                  <span className="size-1.5 rounded-full bg-orange" />
                  {c} HELD
                </li>
              ))}
            </ul>
          }
        />
        <span className="hf-wiggle label absolute top-1/2 left-1/2 z-10 hidden -translate-x-1/2 rotate-[3deg] bg-orange-key px-2.5 py-1 text-[12px] text-ink normal-case md:block md:top-[264px]">
          {multiple()}
        </span>
      </div>
      <p className="mt-6 text-[13px] text-body">{brands.note}</p>
    </section>
  );
}

function PhotoCard({
  row,
  shown,
  accent,
  image,
  tag,
  overlay,
}: {
  row: ComparisonRow;
  shown: number;
  accent?: boolean;
  image: ReactNode;
  tag: ReactNode;
  overlay?: ReactNode;
}) {
  return (
    <figure className="overflow-hidden rounded-sm border border-line bg-white">
      <div className="relative h-[220px] sm:h-[300px]">
        {image}
        <div className="absolute top-4 left-4">{tag}</div>
        {overlay}
      </div>
      <figcaption className="px-6 pt-6 pb-6">
        <span
          className={cn(
            'block text-[40px] leading-none font-medium tracking-headline tabular-nums',
            accent ? 'text-orange' : 'text-ink',
          )}
        >
          <span aria-hidden>{compactUsd(shown)}</span>
          <span className="sr-only">
            {row.label}: {compactUsd(row.cents)}
          </span>
        </span>
        <span className="mt-3 block text-[15px] text-body">{row.detail}</span>
      </figcaption>
    </figure>
  );
}

const clients: readonly AgentClient[] = ['claude', 'codex', 'opencode'];
const clientLogo: Record<AgentClient, (p: { className?: string }) => ReactNode> = {
  claude: ClaudeLogo,
  codex: OpenAILogo,
  opencode: OpenCodeLogo,
};

function Agents() {
  const [ref, reveal] = useReveal<HTMLElement>();
  return (
    <section
      ref={ref}
      id="for-agents"
      aria-labelledby="agents-title"
      className={cn('hf-reveal scroll-mt-20 border-t border-line py-16 lg:py-24', reveal)}
    >
      <div className="grid grid-cols-1 gap-10 lg:grid-cols-2 lg:gap-16">
        <div>
          <SectionHead
            id="agents-title"
            eyebrow="For agents · MCP"
            title={
              <>
                {agents.lead}
                <Marker>{agents.accent}</Marker>
              </>
            }
          />
          <p className="mt-5 text-[17px] leading-[26px] text-body">{agents.body}</p>
          <p className="mt-6 border-l-2 border-orange pl-4 text-[17px] leading-[25px] text-ink">
            {agents.prompt}
          </p>
          <div className="mt-8">
            <ButtonLink to={paths.developer} size="lg" className="group">
              {agents.cta}
              <span
                aria-hidden
                className="ml-2 inline-block transition-transform duration-150 group-hover:translate-x-1"
              >
                →
              </span>
            </ButtonLink>
          </div>
        </div>
        <AgentCodeCard />
      </div>
    </section>
  );
}

/** Claude Code / Codex / OpenCode tabs with a COPY button; the snippet crossfades (120 ms). */
function AgentCodeCard() {
  const [client, setClient] = useState<AgentClient>('claude');
  const [copied, setCopied] = useState(false);
  const snippets = agentSnippets(typeof window === 'undefined' ? '' : window.location.origin);
  const s = snippets[client];
  useEffect(() => setCopied(false), [client]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(s.code);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="min-w-0 self-start rounded-sm border border-line bg-surface">
      <div className="flex items-stretch justify-between border-b border-line bg-white">
        <div role="tablist" aria-label="MCP client" className="flex min-w-0 overflow-x-auto">
          {clients.map((c) => {
            const Logo = clientLogo[c];
            const on = c === client;
            return (
              <button
                key={c}
                type="button"
                role="tab"
                id={`agent-tab-${c}`}
                aria-selected={on}
                aria-controls="agent-snippet"
                onClick={() => setClient(c)}
                className={cn(
                  'flex shrink-0 items-center gap-1.5 border-b-2 px-2.5 py-3 font-mono text-[11px] sm:gap-2 sm:px-4 sm:text-[13px]',
                  on ? 'border-ink text-ink' : 'border-transparent text-body hover:text-ink',
                )}
              >
                <Logo className="size-3.5" />
                {snippets[c].label}
              </button>
            );
          })}
        </div>
        <div className="flex items-center pr-2 pl-2">
          <button
            type="button"
            onClick={copy}
            className="label rounded-[2px] border border-border px-2 py-1 text-[11px] text-ink hover:bg-surface"
          >
            {agents.copy}
          </button>
        </div>
      </div>
      <div
        id="agent-snippet"
        role="tabpanel"
        aria-labelledby={`agent-tab-${client}`}
        key={client}
        className="hf-fade p-4 sm:p-5"
      >
        <p className="font-mono text-[12px] text-muted">{s.comment}</p>
        <pre className="mt-3 overflow-x-auto font-mono text-[12px] leading-[20px] text-ink sm:text-[13px]">
          <code>{s.code}</code>
        </pre>
        <p aria-live="polite" className="mt-4 min-h-[26px]">
          {copied && (
            <span className="inline-flex items-center gap-2 rounded-[2px] bg-orange-key px-2.5 py-1 font-mono text-[12px] text-ink">
              <span aria-hidden className="size-1.5 rounded-full bg-orange" />
              {agents.copied}
            </span>
          )}
        </p>
      </div>
    </div>
  );
}

function Pricing() {
  const [ref, reveal] = useReveal<HTMLElement>();
  return (
    <section
      ref={ref}
      id="pricing"
      aria-labelledby="pricing-title"
      className={cn('scroll-mt-20 border-t border-line py-16 lg:py-24', reveal)}
    >
      <div className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex flex-col gap-4">
          <p className="label text-[13px] text-orange">Pricing</p>
          <h2
            id="pricing-title"
            className="text-[44px] leading-none font-medium tracking-headline text-ink sm:text-[64px] lg:text-[88px]"
          >
            {pricing.lead}
            {/* Solid orange bar under the accent; grows left → right on enter. */}
            <span className="hf-underline">{pricing.accent}</span>
          </h2>
          <p className="mt-2 text-[17px] leading-[25px] text-body sm:text-[20px]">{pricing.sub}</p>
          <ul className="flex flex-wrap gap-2">
            {pricing.pills.map((p, i) => (
              <li
                key={p}
                className="inline-flex items-center gap-1.5 rounded-full border-[1.5px] border-ink px-3 py-1 font-mono text-[13px] text-ink"
              >
                <CheckIcon
                  className="hf-check size-3.5 text-orange"
                  style={{ animationDelay: `${i * 150}ms` }}
                />
                {p}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <DemoCta variant="button" label={pricing.cta} />
        </div>
      </div>
    </section>
  );
}

/**
 * Background parallax (motion spec, Footer): the image drifts at `speed` times the scroll while
 * the footer is on screen. Off under reduced motion.
 */
function useParallax<T extends HTMLElement>(speed: number) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    const host = el?.closest('footer');
    if (!el || !host || prefersReducedMotion()) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const r = host.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) return;
      // Clamp to the image's 15% overscan (`-top-[15%] h-[130%]`) so no edge ever shows.
      const max = r.height * 0.15;
      const raw = (r.top + r.height / 2 - window.innerHeight / 2) * speed;
      const offset = Math.max(-max, Math.min(max, raw));
      el.style.transform = `translate3d(0, ${offset.toFixed(1)}px, 0)`;
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [speed]);
  return ref;
}

/** v4 footer (`104:75`): the desert sunset with a dark bottom gradient; `#contact` lands here. */
function Footer({ pulse }: { pulse: number }) {
  const bg = useParallax<HTMLImageElement>(0.3);
  return (
    <footer
      id="contact"
      className="relative isolate z-10 mt-8 scroll-mt-16 overflow-hidden bg-charcoal text-white"
    >
      <picture aria-hidden>
        <source
          type="image/avif"
          srcSet={`${desert960Avif} 960w, ${desert1600Avif} 1600w`}
          sizes="100vw"
        />
        <img
          src={desert1600Webp}
          srcSet={`${desert960Webp} 960w, ${desert1600Webp} 1600w`}
          sizes="100vw"
          width={1600}
          height={900}
          ref={bg}
          alt=""
          loading="lazy"
          decoding="async"
          className="absolute inset-x-0 -top-[15%] -z-10 h-[130%] w-full object-cover object-[center_70%] will-change-transform"
        />
      </picture>
      <div
        aria-hidden
        className="absolute inset-0 -z-10 bg-gradient-to-b from-ink/10 via-ink/35 to-ink/85"
      />
      <div className={cn(column, 'pt-28 pb-8 lg:pt-[200px]')}>
        <div className="grid grid-cols-1 gap-10 md:grid-cols-3 md:gap-12">
          <div className="flex flex-col gap-3">
            <span className="text-[32px] leading-none font-semibold tracking-headline">
              Holdfast
            </span>
            <p className="max-w-[320px] text-[16px] leading-[24px] text-white/90">
              {footer.tagline}
            </p>
          </div>
          <div className="flex flex-col gap-3">
            <p className="label text-[11px] text-white/80">{footer.contactTitle}</p>
            <a
              key={pulse}
              href={footer.contact.url}
              target="_blank"
              rel="noreferrer"
              className={cn(
                'flex max-w-[300px] items-center gap-3 rounded-sm bg-white px-4 py-3 text-ink hover:bg-surface',
                pulse > 0 && 'hf-pulse',
              )}
            >
              <LinkedInLogo className="size-6 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-medium">{footer.contact.name}</span>
                <span className="block truncate font-mono text-[11px] text-body underline underline-offset-2">
                  {footer.contact.display}
                </span>
              </span>
              <span aria-hidden className="text-[16px]">
                ↗
              </span>
              <span className="sr-only">(LinkedIn, opens in a new tab)</span>
            </a>
          </div>
          <div className="flex flex-col gap-3">
            <p className="label text-[11px] text-white/80">{footer.builtWith}</p>
            <ul className="flex max-w-[260px] flex-wrap gap-2">
              {sponsors.map((s) => {
                const Logo = SPONSOR_LOGOS[s];
                return (
                  <li
                    key={s}
                    className="inline-flex h-9 items-center gap-2 rounded-sm bg-white px-3 text-[14px] text-ink"
                  >
                    <Logo className="size-4" />
                    {s}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
        <div className="mt-14 flex flex-col gap-4 border-t border-white/30 pt-5 sm:flex-row sm:items-center sm:justify-between">
          <ul className="flex flex-wrap gap-x-7 gap-y-2 font-mono text-[13px]">
            <li>
              <a
                href={GITHUB_URL}
                className="inline-flex items-center gap-1.5 underline underline-offset-4"
              >
                <GitHubLogo className="size-3.5" />
                GitHub · MIT
              </a>
            </li>
            <li>
              <Link to={paths.demo} className="underline underline-offset-4">
                Demo hub
              </Link>
            </li>
            <li>
              <Link to={paths.developer} className="underline underline-offset-4">
                Developers
              </Link>
            </li>
            <li>
              <Link to={paths.docs} className="underline underline-offset-4">
                Docs
              </Link>
            </li>
          </ul>
          <p className="font-mono text-[13px] text-white/90">© 2026 Holdfast</p>
        </div>
      </div>
    </footer>
  );
}

/** M12: the main action stays in reach on phones. */
function StickyCta({ onContact }: { onContact: (e: MouseEvent) => void }) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-white/95 p-3 lg:hidden">
      <a
        href={nav.contact.href}
        onClick={onContact}
        className={buttonClass({ size: 'lg', block: true })}
      >
        {nav.contact.label}
      </a>
    </div>
  );
}

/** Thin vertical guide lines, 48 px outside the content column (v3 → v4: 112 px at 1440). */
function Guides() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 hidden lg:block">
      <div className="relative mx-auto h-full max-w-[1440px]">
        <span className="absolute inset-y-0 left-4 w-px bg-line xl:left-[112px]" />
        <span className="absolute inset-y-0 right-4 w-px bg-line xl:right-[112px]" />
      </div>
    </div>
  );
}
