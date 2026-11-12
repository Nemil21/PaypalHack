import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { AgentCodeCard } from '../components/marketing/AgentCodeCard';
import { Accent, column, MarketingPage } from '../components/marketing/MarketingPage';
import { cn } from '../lib/cn';
import {
  docsHero,
  docsNav,
  docsReference,
  docsSections,
  docsSteps,
  type DocsSection,
} from '../lib/docs';
import { paths } from '../lib/routes';

/**
 * v4 Docs (Figma `107:137`, plan §1): static. The landing's nav and footer, a sticky sidebar
 * (Get started / For brands / Reference) with a scroll spy, "Connect an agent in *one line.*" with
 * three numbered steps, then the guides and the reference. No API calls.
 */
export function DocsPage() {
  const active = useActiveDoc();
  return (
    <MarketingPage current="docs">
      <main
        className={cn(
          column,
          'relative z-10 grid grid-cols-1 gap-10 pt-10 pb-20 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-16 lg:pt-[72px]',
        )}
      >
        <DocsSidebar active={active} />
        <article className="min-w-0 max-w-[800px]">
          <header id="connect-an-agent" className="scroll-mt-24">
            <p className="label text-[13px] text-orange">{docsHero.eyebrow}</p>
            <h1 className="mt-4 text-[36px] leading-[1.08] font-medium tracking-headline text-ink sm:text-[48px] lg:text-[56px]">
              {docsHero.lead}
              <Accent>{docsHero.accent}</Accent>
            </h1>
            <p className="mt-6 max-w-[640px] text-[17px] leading-[27px] text-body sm:text-[19px] sm:leading-[29px]">
              {docsHero.lede}
            </p>
          </header>

          <ol className="mt-10 border-t border-line">
            {docsSteps.map((s, i) => (
              <li key={s.title} className="flex gap-4 border-b border-line py-8 sm:gap-5">
                <span
                  aria-hidden
                  className="flex size-7 shrink-0 items-center justify-center rounded-full bg-ink font-mono text-[12px] text-white"
                >
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <h2 className="text-[20px] leading-7 font-medium text-ink sm:text-[22px]">
                    {s.title}
                  </h2>
                  <p className="mt-2 text-[16px] leading-[25px] text-body">{s.body}</p>
                  {i === 0 && (
                    <>
                      <AgentCodeCard className="mt-5" />
                      <Link
                        to={paths.developer}
                        className="mt-4 inline-block font-mono text-[13px] text-ink underline underline-offset-4 hover:text-orange"
                      >
                        Create a token →
                      </Link>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ol>

          {docsSections.map((s) => (
            <GuideSection key={s.id} section={s} />
          ))}

          <section id="mcp-tools" className="scroll-mt-24 border-b border-line py-10">
            <h2 className="text-[26px] font-medium tracking-title text-ink">
              {docsReference.mcp.title}
            </h2>
            <p className="mt-3 text-[16px] leading-[25px] text-body">{docsReference.mcp.lede}</p>
            <ul className="mt-5 divide-y divide-line border-y border-line">
              {docsReference.mcp.tools.map((t) => (
                <li key={t.name} className="flex flex-col gap-1 py-4">
                  <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <code className="font-mono text-[14px] text-ink">{t.name}</code>
                    <code className="font-mono text-[12px] break-all text-body">{t.input}</code>
                    <span className="label rounded-[2px] bg-surface px-1.5 py-0.5 text-[10px] text-body">
                      {t.scope}
                    </span>
                  </p>
                  <p className="text-[15px] leading-[23px] text-body">{t.description}</p>
                </li>
              ))}
            </ul>
          </section>

          <section id="rest-api" className="scroll-mt-24 border-b border-line py-10">
            <h2 className="text-[26px] font-medium tracking-title text-ink">
              {docsReference.rest.title}
            </h2>
            {docsReference.rest.paragraphs.map((p) => (
              <p key={p} className="mt-3 text-[16px] leading-[25px] text-body">
                {p}
              </p>
            ))}
          </section>

          <section id="webhooks" className="scroll-mt-24 py-10">
            <h2 className="text-[26px] font-medium tracking-title text-ink">
              {docsReference.webhooks.title}
            </h2>
            {docsReference.webhooks.paragraphs.map((p) => (
              <p key={p} className="mt-3 text-[16px] leading-[25px] text-body">
                {p}
              </p>
            ))}
          </section>
        </article>
      </main>
    </MarketingPage>
  );
}

function GuideSection({ section }: { section: DocsSection }) {
  return (
    <section id={section.id} className="scroll-mt-24 border-b border-line py-10">
      <h2 className="text-[26px] font-medium tracking-title text-ink">{section.title}</h2>
      {section.paragraphs.map((p) => (
        <p key={p} className="mt-3 text-[16px] leading-[25px] text-body">
          {p}
        </p>
      ))}
      {section.links && (
        <ul className="mt-4 flex flex-wrap gap-x-6 gap-y-2">
          {section.links.map((l) => (
            <li key={l.to}>
              <Link
                to={l.to}
                className="font-mono text-[13px] text-ink underline underline-offset-4 hover:text-orange"
              >
                {l.label} →
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function DocsSidebar({ active }: { active: string }) {
  return (
    <nav aria-label="Docs" className="lg:sticky lg:top-24 lg:self-start">
      <div className="flex gap-8 overflow-x-auto pb-2 lg:flex-col lg:gap-7 lg:overflow-visible lg:pb-0">
        {docsNav.map((g) => (
          <div key={g.group} className="shrink-0">
            <p className="label text-[11px] text-body">{g.group}</p>
            <ul className="mt-3 flex flex-col">
              {g.links.map((l) => {
                const on = l.id === active;
                return (
                  <li key={l.id}>
                    <a
                      href={`#${l.id}`}
                      aria-current={on ? 'location' : undefined}
                      className={cn(
                        'block border-l py-1.5 pl-3 text-[15px] transition-colors',
                        on
                          ? 'border-l-2 border-orange pl-[11px] text-ink'
                          : 'border-line text-body hover:text-ink',
                      )}
                    >
                      {l.label}
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}

const docIds = docsNav.flatMap((g) => g.links.map((l) => l.id));

/** The docs section nearest the top of the viewport; starts on "Connect an agent" (the hero). */
function useActiveDoc(): string {
  const [active, setActive] = useState('connect-an-agent');
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setActive(e.target.id);
      },
      { rootMargin: '-20% 0px -70% 0px' },
    );
    for (const id of docIds) {
      const el = document.getElementById(id);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, []);
  return active;
}
