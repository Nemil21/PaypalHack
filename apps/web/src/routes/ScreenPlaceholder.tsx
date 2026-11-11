import { useEffect } from 'react';
import { useLocation, useRouteError } from 'react-router';
import { PageHeader } from '../components/layout/AppShell';
import { ButtonLink, EmptyState } from '../components/ui';
import { claimChunkReload, isChunkLoadError } from '../lib/chunk-reload';
import { paths } from '../lib/routes';

/** Route reserved for a later ticket; the shell, tokens and components are ready for it. */
export function ScreenPlaceholder({ screen, ticket }: { screen: string; ticket: string }) {
  const { pathname } = useLocation();
  return (
    <>
      <PageHeader eyebrow={pathname} title={screen} />
      <EmptyState
        message={`This screen arrives with ${ticket}.`}
        action={
          <ButtonLink to={paths.demo} variant="outline">
            Back to demo hub
          </ButtonLink>
        }
      />
    </>
  );
}

export function NotFound() {
  return (
    <>
      <PageHeader eyebrow="404" title="We couldn't find that page." />
      <EmptyState
        message="The link may be old, or the listing may have ended."
        action={
          <ButtonLink to={paths.demo} variant="outline">
            Back to demo hub
          </ButtonLink>
        }
      />
    </>
  );
}

/**
 * Route error boundary (HF-057). A lazy screen chunk that fails to load (a tab older than the last
 * deploy) reloads the page once; anything else, or a second failure, shows a way back.
 */
export function RouteError() {
  const error = useRouteError();
  const chunk = isChunkLoadError(error);
  const reloading = chunk && claimChunkReload(sessionStorageOrUndefined());
  useEffect(() => {
    if (reloading) window.location.reload();
  }, [reloading]);
  if (reloading) return null;
  return (
    <main className="mx-auto w-full max-w-[1440px] px-4 pb-16 sm:px-8 lg:px-18">
      <PageHeader eyebrow="Error" title="Something went wrong loading this page." />
      <EmptyState
        message={
          chunk
            ? 'Holdfast was just updated. Reload to get the latest version.'
            : 'Try again, or start from the demo hub.'
        }
        action={
          <ButtonLink to={paths.demo} variant="outline" reloadDocument>
            Back to demo hub
          </ButtonLink>
        }
      />
    </main>
  );
}

function sessionStorageOrUndefined(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}
