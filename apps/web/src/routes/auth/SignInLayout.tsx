import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { paths } from '../../lib/routes';
import { SHARED, type Heading } from '../../lib/sign-in';

/**
 * v4 sign-in frame (Figma 109:112 / 109:132): copy on the left, the action card on the right;
 * stacked on phones. Shared by brand sign-in, buyer sign-in and the invite landing (§4.4).
 */

/** Plain heading with its accent word in orange serif italic. */
export function AccentHeading({ heading, className }: { heading: Heading; className?: string }) {
  return (
    <h1
      className={
        className ??
        'text-[36px] leading-[1.08] font-medium tracking-headline text-ink sm:text-[48px] lg:text-[56px]'
      }
    >
      {heading.lead}
      <em className="font-serif font-normal text-orange italic">{heading.accent}</em>
      {heading.tail}
    </h1>
  );
}

export function SignInLayout({
  eyebrow,
  heading,
  lede,
  back = { to: paths.signIn, label: SHARED.changeRole },
  cardLabel,
  children,
}: {
  eyebrow: string;
  heading: Heading;
  lede: ReactNode;
  back?: { to: string; label: string } | null;
  /** Accessible name for the action card. */
  cardLabel: string;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 gap-10 pt-8 pb-16 lg:grid-cols-[1fr_minmax(0,480px)] lg:gap-20 lg:pt-16">
      <section className="flex max-w-[520px] flex-col gap-4">
        {back && (
          <Link
            to={back.to}
            className="label w-fit text-[12px] text-body transition-colors hover:text-ink"
          >
            ← {back.label}
          </Link>
        )}
        <span className="label text-[13px] text-orange">{eyebrow}</span>
        <AccentHeading heading={heading} />
        <p className="text-[16px] leading-[25px] text-body">{lede}</p>
      </section>

      <section
        aria-label={cardLabel}
        className="flex min-w-0 flex-col gap-4 self-start rounded-sm border border-line bg-white p-5 sm:p-6"
      >
        {children}
      </section>
    </div>
  );
}

/** "— or try it —" rule between the real sign-in and the demo panel. */
export function OrDivider() {
  return (
    <div className="flex items-center gap-3" aria-hidden>
      <span className="h-px flex-1 bg-line" />
      <span className="label text-[11px] text-muted">{SHARED.orTryIt}</span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

/** Grey demo box with the "Demo mode · PayPal sandbox" badge (DEMO_MODE only). */
export function DemoPanel({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 rounded-sm bg-surface p-3 sm:p-4">
      <span className="label w-fit rounded-sm bg-orange-key px-2 py-1 text-[10px] text-ink">
        {SHARED.demoBadge}
      </span>
      {children}
    </div>
  );
}
