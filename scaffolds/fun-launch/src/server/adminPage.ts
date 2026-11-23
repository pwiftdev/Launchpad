import type { GetServerSideProps, GetServerSidePropsContext } from 'next';
import { ADMIN_COOKIE, readAdminSession } from './adminSession';
import { launchpadIsPublic, launchpadPage } from '@/lib/accessRoutes';

/** Check inside the renderer too, so page access never depends on middleware alone. */
export function adminPageRedirect({ req, res, resolvedUrl }: GetServerSidePropsContext) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Vary', 'Cookie');
  if (launchpadIsPublic() && typeof resolvedUrl === 'string' && launchpadPage(resolvedUrl))
    return null;
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  if (readAdminSession(req.cookies[ADMIN_COOKIE])) return null;
  return { redirect: { destination: '/whitelist', permanent: false as const } };
}

export const requireAdminPage: GetServerSideProps = async (context) =>
  adminPageRedirect(context) ?? { props: {} };
