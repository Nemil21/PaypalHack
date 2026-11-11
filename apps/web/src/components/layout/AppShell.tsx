import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { cn } from '../../lib/cn';
import { DEMO_OFFER_SLUG, paths } from '../../lib/routes';
import { setShortcutsEnabled, shortcutFor, shortcutsEnabled } from '../../lib/shortcuts';
import { ButtonLink } from '../ui';

const links = [
  { to: paths.brand, label: 'For brands' },
  { to: paths.agent, label: 'For agents' },
  { to: paths.bids, label: 'My bids' },
  { to: paths.developer, label: 'Developer' },
];

/** Page frame: v3 nav, thin vertical guide lines (desktop), centred 1440 px content column. */
export function AppShell() {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => setOpen(false), [location.pathname]);

  // B → brand console, P → place a bid; guarded in lib/shortcuts.ts, can be turned off.
  const [shortcuts, setShortcuts] = useState(() => shortcutsEnabled(safeStorage()));
  useEffect(() => {
    if (!shortcuts) return;
    const onKey = (e: KeyboardEvent) => {
      const hit = shortcutFor(e, document);
      if (hit === 'brand') navigate(paths.brand);
      if (hit === 'bid') navigate(paths.offer(DEMO_OFFER_SLUG));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, shortcuts]);
  const toggleShortcuts = () => {
    setShortcutsEnabled(safeStorage(), !shortcuts);
    setShortcuts(!shortcuts);
  };

  return (
    <div className="relative min-h-dvh">
      <Guides />
      <header className="relative z-10 mx-auto flex h-16 w-full max-w-[1440px] items-center justify-between gap-4 px-4 sm:px-8 lg:h-[88px] lg:px-18">
        <Link to={paths.home} className="text-[23px] font-semibold tracking-headline text-ink">
          Holdfast
        </Link>
        <nav aria-label="Main" className="hidden items-center gap-8 lg:flex">
          <ul className="flex items-center gap-[30px]">
            {links.map((l) => (
              <li key={l.to}>
                <NavLink
                  to={l.to}
                  className={({ isActive }) =>
                    cn(
                      'font-mono text-[13px] tracking-[0.02em] hover:text-ink',
                      isActive ? 'text-ink' : 'text-body',
                    )
                  }
                >
                  {l.label}
                </NavLink>
              </li>
            ))}
          </ul>
          <div className="flex items-center gap-2">
            <ButtonLink to={paths.brand} variant="secondary" shortcut={shortcuts ? 'B' : undefined}>
              For brands
            </ButtonLink>
            <ButtonLink to={paths.offer(DEMO_OFFER_SLUG)} shortcut={shortcuts ? 'P' : undefined}>
              Place a bid
            </ButtonLink>
          </div>
        </nav>
        <div className="flex items-center gap-2 lg:hidden">
          <ButtonLink to={paths.offer(DEMO_OFFER_SLUG)}>Place a bid</ButtonLink>
          <button
            type="button"
            className="label h-9 rounded-sm border border-border px-3 text-[13px] text-charcoal"
            aria-expanded={open}
            aria-controls="mobile-nav"
            onClick={() => setOpen((o) => !o)}
          >
            {open ? 'Close' : 'Menu'}
          </button>
        </div>
      </header>
      {open && (
        <nav
          id="mobile-nav"
          aria-label="Main"
          className="relative z-10 border-y border-line bg-white px-4 py-2 sm:px-8 lg:hidden"
        >
          <ul className="flex flex-col">
            {[{ to: paths.home, label: 'Demo hub' }, ...links].map((l) => (
              <li key={l.to}>
                <Link to={l.to} className="label block py-3 text-[13px] text-ink">
                  {l.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      )}
      <main className="relative z-10 mx-auto w-full max-w-[1440px] px-4 pb-24 sm:px-8 lg:px-18">
        <Outlet />
      </main>
      <footer className="relative z-10 mx-auto hidden w-full max-w-[1440px] px-8 pb-8 lg:block lg:px-18">
        <button
          type="button"
          onClick={toggleShortcuts}
          aria-pressed={shortcuts}
          className="label text-[11px] text-muted hover:text-ink"
        >
          Keyboard shortcuts {shortcuts ? 'on' : 'off'} · turn {shortcuts ? 'off' : 'on'}
        </button>
      </footer>
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

/** Page heading block used by every screen: mono eyebrow, Geist headline, optional lede. */
export function PageHeader({
  eyebrow,
  title,
  lede,
}: {
  eyebrow?: string;
  title: string;
  lede?: string;
}) {
  return (
    <div className="flex flex-col gap-3 pt-8 pb-8 lg:pt-16 lg:pb-12">
      {eyebrow && <span className="label text-[13px] text-orange">{eyebrow}</span>}
      <h1 className="text-[32px] leading-[1.1] font-medium tracking-headline text-ink sm:text-[44px] lg:text-[56px]">
        {title}
      </h1>
      {lede && (
        <p className="max-w-[720px] text-[17px] leading-[25px] text-body sm:text-[19px] sm:leading-[30px]">
          {lede}
        </p>
      )}
    </div>
  );
}

function safeStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
