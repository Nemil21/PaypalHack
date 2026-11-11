import { Link } from 'react-router';
import { AFFILIATE_DISCLOSURE } from '@holdfast/shared';
import { Badge, buttonClass } from '../../components/ui';
import { errorCopy, errorVariant, type ErrorContext, type ErrorLink } from '../../lib/bids';
import { cn } from '../../lib/cn';

/**
 * W21 error & edge states (HF-020). One component, rendered from an error code: the four specific
 * variants (window closed, hold failed, price dropped, declined at clearing) and one generic layout
 * for above mandate / 404 / session expired / anything else. Copy lives in lib/bids.ts.
 */
export function ErrorState({
  code,
  context,
  className,
}: {
  code: string | null | undefined;
  context?: ErrorContext;
  className?: string;
}) {
  const copy = errorCopy(errorVariant(code), context);
  const specific = ['window_closed', 'hold_failed', 'price_dropped', 'declined'].includes(
    copy.variant,
  );
  return (
    <section
      role="alert"
      aria-labelledby="w21-title"
      data-variant={copy.variant}
      className={cn(
        'flex flex-col gap-4 rounded-md border p-5 sm:p-6',
        specific ? 'border-line bg-white shadow-card' : 'border-dashed border-planned bg-surface',
        className,
      )}
    >
      {copy.replayed && (
        <Badge tone="sim" className="self-start">
          Replayed event (demo)
        </Badge>
      )}
      <h2
        id="w21-title"
        className="text-[22px] leading-[1.15] font-medium tracking-headline text-ink sm:text-[26px]"
      >
        {copy.title}
      </h2>
      <p className="text-[15px] text-body">{copy.body}</p>
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <ActionLink link={copy.primary} variant="primary" />
        {copy.secondary && <ActionLink link={copy.secondary} variant="outline" />}
      </div>
      {copy.affiliate && <p className="text-[12px] text-muted">{AFFILIATE_DISCLOSURE}</p>}
    </section>
  );
}

export function ActionLink({
  link,
  variant,
}: {
  link: ErrorLink;
  variant: 'primary' | 'outline' | 'secondary';
}) {
  const cls = buttonClass({ variant, size: 'lg' });
  if (link.external) {
    return (
      <a href={link.href} target="_blank" rel="sponsored noopener noreferrer" className={cls}>
        {link.label}
      </a>
    );
  }
  if (link.href === '') {
    return (
      <button type="button" className={cls} onClick={() => window.location.reload()}>
        {link.label}
      </button>
    );
  }
  return (
    <Link to={link.href} className={cls}>
      {link.label}
    </Link>
  );
}
