import { NextResponse, type NextRequest } from 'next/server';
import { accessPath, launchpadIsPublic, publicApi, publicPage } from '@/lib/accessRoutes';
import { parseReferralCode } from '@/lib/whitelist';
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
    policy = contentSecurityPolicy(nonce);
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
  if ((api && publicApi(path, open)) || (!api && publicPage(path, open))) return secure(next());
  if (readAdminSession(request.cookies.get(ADMIN_COOKIE)?.value)) {
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
      '/whitelist',
      siteOriginForHeaders({ host: request.headers.get('host') ?? '' })
    );
    const referral = parseReferralCode(request.nextUrl.searchParams.get('ref'));
    if (referral) destination.searchParams.set('ref', referral);
    response = NextResponse.redirect(destination, 307);
  }
  response.headers.set('Cache-Control', 'private, no-store');
  response.headers.set('Vary', 'Cookie');
  response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return secure(response);
}

export const config = {
  runtime: 'nodejs',
  matcher: ['/((?!_next/static/|_next/webpack-hmr).*)'],
};
