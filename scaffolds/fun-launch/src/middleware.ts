import { NextResponse, type NextRequest } from 'next/server';
import { accessPath, launchpadIsPublic, publicApi, publicPage } from '@/lib/accessRoutes';
import { OTC_PATH } from '@/constants/nav';
import { ADMIN_COOKIE, readAdminSession } from '@/server/adminSession';
import { siteOriginForHeaders } from '@/server/siteOrigin';
import { contentSecurityPolicy, newScriptNonce, NONCE_HEADER } from '@/server/securityHeaders';

export function middleware(request: NextRequest) {
  const path = accessPath(request.nextUrl.pathname);
  const open = launchpadIsPublic();
  const api = path === '/api' || path.startsWith('/api/');
  // Checked-in public brand images do not contain a document nonce and keep normal caching.
  if (!api && publicPage(path, open) && /\.(?:png|svg|ico|webp|jpe?g|gif)$/.test(path))
    return NextResponse.next();
  const nonce = newScriptNonce(),
    policy = contentSecurityPolicy(nonce, undefined, path === OTC_PATH);
  const headers = new Headers(request.headers);
  // Never trust a client-supplied nonce or policy header.
  headers.set(NONCE_HEADER, nonce);
  headers.set('Content-Security-Policy', policy);
  const next = () => NextResponse.next({ request: { headers } });
  const secure = (response: NextResponse) => {
    response.headers.set('Content-Security-Policy', policy);
    if (!api) response.headers.set('Cache-Control', 'private, no-store');
    return response;
  };
  if (path === '/api/whitelist')
    return secure(
      new NextResponse(null, { status: 410, headers: { 'Cache-Control': 'no-store' } })
    );
  if ((api && publicApi(path, open)) || (!api && publicPage(path, open))) return secure(next());
  if (!open && readAdminSession(request.cookies.get(ADMIN_COOKIE)?.value)) {
    const response = next();
    response.headers.set('Cache-Control', 'private, no-store');
    response.headers.set('Vary', 'Cookie');
    response.headers.set('X-Robots-Tag', 'noindex, nofollow');
    return secure(response);
  }
  let response: NextResponse;
  if (api) {
    response = NextResponse.json({ error: 'Admin access required' }, { status: 401 });
  } else {
    const destination = new URL(
      open ? '/' : '/admin',
      siteOriginForHeaders({ host: request.headers.get('host') ?? '' })
    );
    response = NextResponse.redirect(destination, 307);
  }
  response.headers.set('Cache-Control', 'private, no-store');
  response.headers.set('Vary', 'Cookie');
  response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return secure(response);
}

export const config = {
  runtime: 'nodejs',
  // Artwork routes enforce access in apiGuard and read the request without a middleware body copy.
  matcher: ['/((?!_next/static/|_next/webpack-hmr|api/(?:upload|launch-previews)/?$).*)'],
};
