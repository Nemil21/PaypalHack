import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { BrandListingView } from '@holdfast/shared';
import { PageHeader } from '../../components/layout/AppShell';
import { Button, useToast } from '../../components/ui';
import { api } from '../../lib/api';
import { BRAND_DEVELOPER as COPY, BRAND_GUIDES } from '../../lib/brand-developer';
import { shareableListings, widgetSnippet } from '../../lib/embed';
import { DEMO_OFFER_SLUG, paths } from '../../lib/routes';

/**
 * v4 brand Developer view (Figma 113:235; plan §3.4, decision 4): docs only. Guides link into
 * `/docs`; the embed snippet uses the brand's first shareable listing (the demo slug until one
 * exists). There are no brand API keys or webhooks, so there is no "Create API key" button.
 */
export function BrandDeveloper() {
  const toast = useToast();
  const [slug, setSlug] = useState<string>(DEMO_OFFER_SLUG);

  useEffect(() => {
    let live = true;
    api
      .request<{ listings: BrandListingView[] }>({ method: 'GET', path: '/api/listings' })
      .then((res) => {
        const first = shareableListings(res.listings)[0];
        if (live && first?.slug) setSlug(first.slug);
      })
      .catch(() => {
        // Keep the demo slug: the snippet still shows the shape.
      });
    return () => {
      live = false;
    };
  }, []);

  const snippet = widgetSnippet(window.location.origin, slug, 'light');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      toast.show({ title: 'Snippet copied', tone: 'success' });
    } catch {
      toast.show({ title: 'Couldn’t copy. Select the text and copy it.', tone: 'error' });
    }
  };

  return (
    <>
      <PageHeader eyebrow={COPY.eyebrow} title={COPY.title} lede={COPY.lede} />
      <div className="flex flex-col gap-5 pb-16">
        <section className="flex flex-col gap-3 rounded-sm border border-line bg-white p-4 sm:p-5">
          <h2 className="label text-[11px] text-muted">{COPY.guidesTitle}</h2>
          <ul className="flex flex-col divide-y divide-line border-t border-line">
            {BRAND_GUIDES.map((g) => (
              <li key={g.title}>
                <Link
                  to={g.to}
                  className="group flex flex-col gap-2 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
                >
                  <span className="min-w-0">
                    <span className="block text-[15px] text-ink">{g.title}</span>
                    <span className="block text-[13px] text-body">{g.body}</span>
                  </span>
                  <span className="label shrink-0 text-[12px] text-ink group-hover:text-orange">
                    {COPY.readInDocs} →
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>

        <section className="flex flex-col gap-4 rounded-sm border border-line bg-white p-4 sm:p-5">
          <h2 className="label text-[11px] text-muted">{COPY.embedTitle}</h2>
          <pre className="overflow-x-auto rounded-sm bg-surface p-4 font-mono text-[12px] leading-[19px] whitespace-pre-wrap break-all text-ink">
            {snippet}
          </pre>
          <p className="text-[13px] text-body">{COPY.embedNote}</p>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <Button variant="outline" onClick={() => void copy()}>
              Copy snippet
            </Button>
            <Link
              to={`${paths.docs}#open-a-window`}
              className="label text-[12px] text-ink hover:text-orange"
            >
              {COPY.fullReference} →
            </Link>
            <Link to={paths.brandEmbed} className="label text-[12px] text-body hover:text-ink">
              {COPY.openEmbed} →
            </Link>
          </div>
        </section>
      </div>
    </>
  );
}
