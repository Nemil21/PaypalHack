import { Link, Outlet, useLocation, useOutletContext } from 'react-router';
import { BRAND_NAV, canCreateListing } from '../../lib/brand-overview';
import { cn } from '../../lib/cn';
import { paths } from '../../lib/routes';
import type { BrandContext } from '../../routes/brand/BrandGate';
import { ButtonLink } from '../ui';

/**
 * The brand left sidebar (v4 §2.1, frame 111:27): Overview, Listings, Embed and "New listing".
 * Payouts and Settings moved to the top nav. Drawn by `BrandSectionLayout` on every brand
 * section page (Overview, Payouts, Embed, Settings, Notifications); drill-in pages (console,
 * settlement, wizard) have a back link instead and no sidebar.
 */
export function BrandSectionLayout() {
  const ctx = useOutletContext<BrandContext>();
  return (
    <div className="flex flex-col lg:flex-row lg:gap-8">
      <BrandNav canCreate={canCreateListing(ctx.me.role)} />
      <div className="min-w-0 flex-1">
        <Outlet context={ctx} />
      </div>
    </div>
  );
}

export function BrandNav({ canCreate = false }: { canCreate?: boolean }) {
  const { pathname, hash } = useLocation();
  return (
    <nav
      aria-label="Brand"
      className="-mx-4 flex items-center gap-3 overflow-x-auto border-b border-line px-4 pt-4 pb-3 sm:-mx-8 sm:px-8 lg:mx-0 lg:w-56 lg:shrink-0 lg:flex-col lg:items-stretch lg:gap-6 lg:overflow-visible lg:border-r lg:border-b-0 lg:px-0 lg:pt-8 lg:pr-4 lg:pb-0"
    >
      <ul className="flex gap-1 lg:flex-col">
        {BRAND_NAV.map((n) => {
          const [to, anchor] = n.to.split('#');
          // Overview and Listings share `/brand` while Listings is an anchor: the hash decides.
          const active = pathname === to && (anchor ? hash === `#${anchor}` : !hash);
          return (
            <li key={n.label} className="shrink-0">
              <Link
                to={n.to}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex items-center rounded-sm px-3 py-2 text-[14px] hover:bg-surface',
                  active ? 'bg-surface text-ink' : 'text-body',
                )}
              >
                {n.label}
              </Link>
            </li>
          );
        })}
      </ul>
      {canCreate && (
        <ButtonLink to={paths.newListing} className="shrink-0 lg:self-start">
          + New listing
        </ButtonLink>
      )}
    </nav>
  );
}
