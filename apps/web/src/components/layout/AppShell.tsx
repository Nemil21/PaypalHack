import { Suspense, useEffect, useRef, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router';
import { api } from '../../lib/api';
import { cn } from '../../lib/cn';
import { paths } from '../../lib/routes';
import { useApiAction } from '../../lib/use-api-action';
import {
  setShortcutsEnabled,
  shortcutFor,
  shortcutsEnabled,
  shortcutsHint,
} from '../../lib/shortcuts';
import { isLinkActive, shellNav, viewerFor, type MeResponse, type Viewer } from '../../lib/viewer';
import { NotificationBell } from '../NotificationBell';
import { ButtonLink } from '../ui';

/**
 * Page frame: the v4 role-specific nav (frames 109:21 brand, 109:40 buyer, 109:59 public), thin
 * vertical guide lines (desktop), centred 1440 px content column. The role comes from
 * `GET /api/me` (lib/viewer.ts), re-read on every navigation so a sign-in or sign-out shows.
 */
export function AppShell() {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => setOpen(false), [location.pathname]);
  // `/o/:slug?embed=1` (HF-055): no header, nav or footer, for W10 previews. The widget itself
  // opens a normal tab (PayPal approval can't be framed), so this is never the shopper's path.
  const embed = isEmbed(location.pathname, location.search);
  const me = useMe(location.pathname, !embed);
  const viewer = me === undefined ? null : viewerFor(me, location.pathname);
  const role = viewer?.role ?? 'public';
  const nav = shellNav(role);

  // Role-specific S / P (lib/shortcuts.ts); guarded against fields, can be turned off.
  const [shortcuts, setShortcuts] = useState(() => shortcutsEnabled(safeStorage()));
  useEffect(() => {
    if (!shortcuts || role === 'public') return;
    const onKey = (e: KeyboardEvent) => {
      const hit = shortcutFor(e, document, role);
      if (hit) navigate(hit.to);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, shortcuts, role]);
  const toggleShortcuts = () => {
    setShortcutsEnabled(safeStorage(), !shortcuts);
    setShortcuts(!shortcuts);
  };
  const hint = shortcutsHint(role);

  return (
    <div className="relative min-h-dvh">
      {!embed && <Guides />}
      {!embed && (
        <header className="relative z-20 border-b border-line bg-white">
          <div className="mx-auto flex h-16 w-full max-w-[1440px] items-center justify-between gap-3 px-4 sm:px-8 lg:h-[82px] lg:px-18">
            <div className="flex min-w-0 items-center gap-3 lg:gap-4">
              <Link
                to={nav.home}
                className="shrink-0 text-[23px] font-semibold tracking-headline text-ink"
              >
                Holdfast
              </Link>
              {viewer && viewer.role !== 'public' && <RoleChip viewer={viewer} />}
            </div>

            {viewer === null ? null : viewer.role === 'public' ? (
              <Link to={paths.home} className="font-mono text-[13px] text-body hover:text-ink">
                <span aria-hidden>← </span>Back to site
              </Link>
            ) : (
              <>
                <nav aria-label="Main" className="hidden items-center gap-10 lg:flex">
                  <ul className="flex items-center gap-7">
                    {nav.links.map((l) => (
                      <li key={l.label}>
                        <Link
                          to={l.to}
                          aria-current={
                            isLinkActive(location.pathname, l.activePrefix) ? 'page' : undefined
                          }
                          className={cn(
                            'border-b-[1.5px] py-1.5 font-mono text-[13px] tracking-[0.02em] transition-colors hover:text-ink',
                            isLinkActive(location.pathname, l.activePrefix)
                              ? 'border-ink text-ink'
                              : 'border-transparent text-body',
                          )}
                        >
                          {l.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                  <div className="flex items-center gap-2">
                    {nav.actions.map((a) => (
                      <ButtonLink
                        key={a.label}
                        to={a.to}
                        variant={a.variant}
                        shortcut={shortcuts ? a.shortcut : undefined}
                        aria-keyshortcuts={shortcuts ? a.shortcut : undefined}
                      >
                        {a.label}
                      </ButtonLink>
                    ))}
                    <NotificationBell
                      variant="nav"
                      audience={viewer.role === 'brand' ? 'brand' : 'shopper'}
                    />
                    <AccountMenu viewer={viewer} />
                  </div>
                </nav>
                <div className="flex items-center gap-1 lg:hidden">
                  <NotificationBell
                    variant="nav"
                    audience={viewer.role === 'brand' ? 'brand' : 'shopper'}
                  />
                  <button
                    type="button"
                    className="label ml-1 h-9 rounded-sm border border-border px-3 text-[13px] text-charcoal"
                    aria-expanded={open}
                    aria-controls="mobile-nav"
                    onClick={() => setOpen((o) => !o)}
                  >
                    {open ? 'Close' : 'Menu'}
                  </button>
                </div>
              </>
            )}
          </div>
        </header>
      )}
      {!embed && open && viewer && viewer.role !== 'public' && (
        <nav
          id="mobile-nav"
          aria-label="Main"
          className="relative z-10 border-b border-line bg-white px-4 py-2 sm:px-8 lg:hidden"
        >
          <ul className="flex flex-col">
            {[...nav.links, ...nav.actions].map((l) => (
              <li key={l.label}>
                <Link to={l.to} className="label block py-3 text-[13px] text-ink">
                  {l.label}
                </Link>
              </li>
            ))}
            <li>
              <SignOutButton
                viewer={viewer}
                className="label block w-full py-3 text-left text-[13px] text-ink"
              />
            </li>
          </ul>
        </nav>
      )}
      <main className="relative z-10 mx-auto w-full max-w-[1440px] px-4 pb-16 sm:px-8 lg:px-18">
        {/* Screens are lazy chunks (app.tsx); a first load shows the frame until one arrives. */}
        <Suspense fallback={null}>
          <Outlet />
        </Suspense>
      </main>
      {/* Shown at every width: the listener is active everywhere (hardware keyboards on tablets,
          narrow or zoomed windows), so the opt-out and the key names must be too (WCAG 2.1.4). */}
      {!embed && hint && (
        <footer className="relative z-10 mx-auto w-full max-w-[1440px] px-4 pb-8 sm:px-8 lg:px-18">
          <button
            type="button"
            onClick={toggleShortcuts}
            aria-pressed={shortcuts}
            className="label text-[11px] text-muted hover:text-ink"
          >
            Keyboard shortcuts ({hint}) {shortcuts ? 'on' : 'off'} · turn {shortcuts ? 'off' : 'on'}
          </button>
        </footer>
      )}
    </div>
  );
}

/**
 * `GET /api/me`, re-read on each navigation (sign-in and sign-out pages navigate afterwards).
 * `undefined` until the first answer, so the nav does not flash the public variant; a failed
 * read keeps the last answer (or falls back to public on the first one).
 */
function useMe(pathname: string, enabled: boolean): MeResponse | null | undefined {
  const [me, setMe] = useState<MeResponse | null | undefined>(undefined);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    api
      .request<MeResponse>({ method: 'GET', path: '/api/me' })
      .then((m) => live && setMe(m))
      .catch(() => live && setMe((prev) => (prev === undefined ? null : prev)));
    return () => {
      live = false;
    };
  }, [pathname, enabled]);
  return me;
}

/** `BRAND · Aurel Audio` (ink) / `BUYER · Maya R.` (tint) next to the logo. */
function RoleChip({ viewer }: { viewer: Viewer }) {
  const brand = viewer.role === 'brand';
  return (
    <span
      className={cn(
        'min-w-0 truncate rounded-sm px-2 py-1 font-mono text-[11px] leading-none',
        brand ? 'bg-ink text-white' : 'bg-orange-key text-ink',
      )}
    >
      {brand ? 'BRAND' : 'BUYER'} · {viewer.name}
    </span>
  );
}

/** Avatar button that opens the account menu: who you are, Settings, Sign out. */
function AccountMenu({ viewer }: { viewer: Viewer }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const brand = viewer.role === 'brand';
  return (
    <div ref={ref} className="relative ml-1">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account menu for ${viewer.name ?? (brand ? 'brand' : 'buyer')}`}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'inline-flex h-8 w-8 items-center justify-center rounded-full font-mono text-[12px] text-white uppercase focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink',
          brand ? 'bg-charcoal' : 'bg-orange',
        )}
      >
        {viewer.name?.trim().charAt(0) ?? ''}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-30 mt-2 w-60 rounded-sm border border-line bg-white py-1 shadow-[0_8px_24px_rgba(20,20,20,0.08)]"
        >
          <div className="border-b border-line px-4 py-3">
            <p className="label text-[11px] text-muted">{brand ? 'Brand' : 'Buyer'}</p>
            <p className="mt-1 truncate text-[15px] text-ink">{viewer.name}</p>
          </div>
          <Link
            role="menuitem"
            to={brand ? paths.brandSettings : paths.settings}
            className="label block px-4 py-3 text-[13px] text-ink hover:bg-surface"
          >
            Settings
          </Link>
          <SignOutButton
            viewer={viewer}
            role="menuitem"
            className="label block w-full px-4 py-3 text-left text-[13px] text-ink hover:bg-surface"
          />
        </div>
      )}
    </div>
  );
}

/** Ends this role's session (`POST /api/auth/logout`) and goes back to the landing page. */
function SignOutButton({
  viewer,
  className,
  role,
}: {
  viewer: Viewer;
  className: string;
  role?: 'menuitem';
}) {
  const navigate = useNavigate();
  const signOut = useApiAction<unknown>();
  const busy = signOut.status === 'pending';
  const onClick = async () => {
    const ok = await signOut.run({
      method: 'POST',
      path: '/api/auth/logout',
      body: { who: viewer.role === 'brand' ? 'brand' : 'shopper' },
    });
    if (ok !== undefined) navigate(paths.home);
  };
  return (
    <button type="button" role={role} disabled={busy} onClick={onClick} className={className}>
      {busy ? 'Signing out…' : 'Sign out'}
    </button>
  );
}

/** Embed mode (HF-055): only offer pages honour `?embed=1`. */
export function isEmbed(pathname: string, search: string): boolean {
  return pathname.startsWith('/o/') && new URLSearchParams(search).get('embed') === '1';
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
