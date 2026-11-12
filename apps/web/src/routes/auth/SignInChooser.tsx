import { Link, useSearchParams } from 'react-router';
import { ButtonLink } from '../../components/ui';
import { safeNext } from '../../lib/brand-sign-in';
import { clientConfig } from '../../lib/client-config';
import { paths } from '../../lib/routes';
import { CHOOSER, ROLE_CARDS, withNext } from '../../lib/sign-in';
import { AccentHeading } from './SignInLayout';

/**
 * v4 role chooser (plan §2.1; Figma 109:63). Brand and buyer are separate sessions (`hf_brand` via
 * PayPal, `hf_shopper` via email link), so the role is picked before the sign-in method.
 */
export function SignInChooser() {
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const demo = clientConfig().demoMode;

  return (
    <div className="flex flex-col items-center gap-10 pt-10 pb-16 lg:pt-16">
      <header className="flex flex-col items-center gap-4 text-center">
        <span className="label text-[13px] text-orange">{CHOOSER.eyebrow}</span>
        <AccentHeading
          heading={CHOOSER.heading}
          className="text-[34px] leading-[1.1] font-medium tracking-headline text-ink sm:text-[44px] lg:text-[52px]"
        />
        <p className="text-[16px] text-body">{CHOOSER.lede}</p>
      </header>

      <ul className="grid w-full max-w-[920px] grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5">
        {ROLE_CARDS.map((card, i) => (
          <li
            key={card.role}
            className="group flex flex-col gap-5 rounded-sm border border-line bg-white p-5 transition-colors focus-within:border-ink hover:border-ink sm:p-6"
          >
            <span className="label text-[11px] text-orange">{card.eyebrow}</span>
            <div className="flex flex-col gap-2">
              <h2 className="text-[26px] leading-[1.15] font-medium text-ink">{card.title}</h2>
              <p className="text-[15px] leading-[23px] text-body">{card.body}</p>
            </div>
            <ul className="flex flex-col gap-1.5">
              {card.points.map((p) => (
                <li key={p} className="flex items-center gap-2.5 font-mono text-[12px] text-ink">
                  <span className="size-1.5 shrink-0 rounded-full bg-orange" aria-hidden />
                  {p}
                </li>
              ))}
            </ul>
            <ButtonLink
              to={withNext(card.to, next)}
              variant={i === 0 ? 'primary' : 'outline'}
              className="mt-auto w-fit"
            >
              {card.cta} →
            </ButtonLink>
          </li>
        ))}
      </ul>

      <p className="text-center font-mono text-[12px] text-muted">
        {demo && <>{CHOOSER.sandbox} · </>}
        {CHOOSER.hubLead}{' '}
        <Link to={paths.demo} className="underline-offset-4 hover:text-ink hover:underline">
          {CHOOSER.hub} →
        </Link>
      </p>
    </div>
  );
}
