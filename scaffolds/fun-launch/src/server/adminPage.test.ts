import type { GetServerSidePropsContext } from 'next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminPageRedirect, requireAdminPage } from './adminPage';
function context(path: string) {
  return {
    resolvedUrl: path,
    req: { cookies: {} },
    res: { setHeader: vi.fn() },
  } as unknown as GetServerSidePropsContext;
}
afterEach(() => vi.unstubAllEnvs());
describe('renderer admission independent of middleware', () => {
  it('keeps the launchpad closed unless the exact runtime switch is enabled', async () => {
    vi.stubEnv('LAUNCHPAD_PUBLIC', 'false');
    expect(adminPageRedirect(context('/launch'))).toMatchObject({
      redirect: { destination: '/whitelist' },
    });
    vi.stubEnv('LAUNCHPAD_PUBLIC', 'true');
    const page = context('/launch?mode=community');
    expect(await requireAdminPage(page)).toEqual({ props: {} });
    expect(page.res.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    expect(page.res.setHeader).not.toHaveBeenCalledWith('X-Robots-Tag', 'noindex, nofollow');
  });
  it('only bypasses admin on a known resolved page, never admin/unknown/login routes', () => {
    vi.stubEnv('LAUNCHPAD_PUBLIC', 'true');
    for (const path of [
      '/admin',
      '/admin/wallet',
      '/unknown',
      '/api/coins',
      '/token/not-a-mint',
      '/whitelist',
    ])
      expect(adminPageRedirect(context(path))).toMatchObject({
        redirect: { destination: '/whitelist' },
      });
    expect(
      adminPageRedirect(context('/token/So11111111111111111111111111111111111111112'))
    ).toBeNull();
    const missing = context('/launch');
    delete (missing as Partial<GetServerSidePropsContext>).resolvedUrl;
    expect(adminPageRedirect(missing)).toMatchObject({ redirect: { destination: '/whitelist' } });
  });
});
