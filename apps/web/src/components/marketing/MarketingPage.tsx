import { useEffect, useRef, useState, type MouseEvent, type ReactNode, type SVGProps } from 'react';
import { Link } from 'react-router';
import desert960Avif from '../../assets/landing/desert-960.avif';
import desert960Webp from '../../assets/landing/desert-960.webp';
import desert1600Avif from '../../assets/landing/desert-1600.avif';
import desert1600Webp from '../../assets/landing/desert-1600.webp';
import { cn } from '../../lib/cn';
import { footer, GITHUB_URL, nav, sponsors } from '../../lib/landing';
import { paths } from '../../lib/routes';
import { GitHubLogo, LinkedInLogo, SPONSOR_LOGOS } from '../logos';
import { ButtonLink, buttonClass } from '../ui';
import './marketing.css';

/**
 * v4 public chrome shared by the landing (`101:4`) and Docs (`107:137`): sticky nav, thin guide
 * lines, the desert footer (`#contact`) and the phone sticky CTA, plus the accent helpers both
 * pages use. Motion is CSS only (`marketing.css`, frame `105:186`), off under reduced motion.
 */
export function MarketingPage({
  current,
  children,
}: {
  /** `landing` links sections in-page with a scroll spy; `docs` links back to `/#…`. */
  current: 'landing' | 'docs';
  children: ReactNode;
}) {
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
            <NavLinks current={current} className="flex items-center gap-[30px]" />
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
            <NavLinks
              current={current}
              className="flex flex-col"
              itemClassName="block py-3 text-ink"
            />
          </nav>
        )}
      </header>
      {children}
      <Footer pulse={pulse} />
      <StickyCta onContact={toContact} />
    </div>
  );
}

/** v4 content column: 1120 px inside 160 px margins at 1440, 16 px gutters on phones. */
export const column = 'mx-auto w-full max-w-[1440px] px-4 sm:px-8 lg:px-16 xl:px-[160px]';

export function prefersReducedMotion(): boolean {
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
export function useReveal<T extends Element>() {
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
const noSections: readonly string[] = [];

/** Body → ink plus a 1.5 px underline that wipes in left → right (180 ms). */
const navLink =
  'hf-wipe font-mono text-[13px] tracking-[0.02em] text-body hover:text-ink aria-[current]:text-ink';

function NavLinks({
  current,
  className,
  itemClassName,
}: {
  current: 'landing' | 'docs';
  className: string;
  itemClassName?: string;
}) {
  const active = useActiveSection(current === 'landing' ? sectionIds : noSections);
  return (
    <ul className={className}>
      {nav.sections.map((s) => (
        <li key={s.id}>
          <a
            href={current === 'landing' ? `#${s.id}` : `${paths.home}#${s.id}`}
            aria-current={active === s.id ? 'true' : undefined}
            className={cn(navLink, itemClassName)}
          >
            {s.label}
          </a>
        </li>
      ))}
      <li>
        <Link
          to={nav.docs.to}
          aria-current={current === 'docs' ? 'page' : undefined}
          className={cn(navLink, itemClassName)}
        >
          {nav.docs.label}
        </Link>
      </li>
    </ul>
  );
}

export function Marker({ children }: { children: ReactNode }) {
  return <span className="hf-marker">{children}</span>;
}

export function CheckIcon(props: SVGProps<SVGSVGElement>) {
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

/** Orange Instrument Serif Italic accent word(s). */
export function Accent({ children }: { children: ReactNode }) {
  return (
    <span className="font-serif text-[1.08em] font-normal tracking-normal text-orange italic">
      {children}
    </span>
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
