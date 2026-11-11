import { useLocation } from 'react-router';
import { PageHeader } from '../components/layout/AppShell';
import { ButtonLink, EmptyState } from '../components/ui';
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
