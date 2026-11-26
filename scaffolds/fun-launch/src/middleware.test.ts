import { describe, expect, it, vi, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { config, middleware } from './middleware';
import { NONCE_HEADER, validScriptNonce } from './server/securityHeaders';

afterEach(() => vi.unstubAllEnvs());
it('leaves artwork request bodies with their handlers while matching adjacent routes', () => {
  const matches = (url: string) => unstable_doesMiddlewareMatch({ config, url });
  for (const path of ['/api/upload', '/api/upload/']) expect(matches(path)).toBe(false);
  for (const path of ['/api/upload/admin', '/api/launch/confirm', '/launch'])
    expect(matches(path)).toBe(true);
});

describe('document nonce forwarding', () => {
  it('replaces attacker-provided nonce/policy and binds one fresh value to request and response', () => {
    const request = new NextRequest('https://launch.example/admin', {
      headers: {
        [NONCE_HEADER]: 'attacker',
        'Content-Security-Policy': 'script-src *',
      },
    });
    const response = middleware(request);
    const nonce = response.headers.get(`x-middleware-request-${NONCE_HEADER}`);
    expect(validScriptNonce(nonce)).toBe(true);
    expect(response.headers.get('Content-Security-Policy')).toContain(`'nonce-${nonce}'`);
    expect(response.headers.get('x-middleware-request-content-security-policy')).toBe(
      response.headers.get('Content-Security-Policy')
    );
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    const next = middleware(new NextRequest('https://launch.example/admin'));
    expect(next.headers.get(`x-middleware-request-${NONCE_HEADER}`)).not.toBe(nonce);
  });
  it('keeps unauthorized APIs and redirects closed while applying the same script protections', () => {
    vi.stubEnv('ADMIN_KEY_HASH', '');
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://launch.example');
    const api = middleware(new NextRequest('https://launch.example/api/coins'));
    expect(api.status).toBe(401);
    expect(api.headers.get('Content-Security-Policy')).toContain("script-src-attr 'none'");
    const page = middleware(
      new NextRequest('https://launch.example/launch', { headers: { host: 'launch.example' } })
    );
    expect(page.status).toBe(307);
    expect(page.headers.get('Location')).toBe('https://launch.example/admin');
  });
  it('never allows WebAssembly or JavaScript eval in production documents', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('LAUNCHPAD_PUBLIC', 'true');
    const policy = (path: string) =>
      middleware(new NextRequest(`https://launch.example${path}`)).headers.get(
        'Content-Security-Policy'
      );
    for (const path of ['/', '/launch', '/api/coins']) {
      expect(policy(path)).not.toContain("'wasm-unsafe-eval'");
      expect(policy(path)).not.toContain("'unsafe-eval'");
    }
  });
  it('returns gone for retired registration without admitting similar API paths', () => {
    for (const value of ['true', 'false']) {
      vi.stubEnv('LAUNCHPAD_PUBLIC', value);
      const gone = middleware(
        new NextRequest('https://launch.example/api/whitelist', { method: 'POST' })
      );
      expect(gone.status).toBe(410);
      expect(gone.headers.get('Cache-Control')).toBe('no-store');
      expect(middleware(new NextRequest('https://launch.example/api/whitelist/admin')).status).toBe(
        401
      );
    }
  });
  it('opens known documents and APIs at runtime while preserving nonce policy and unknown/admin restrictions', () => {
    vi.stubEnv('LAUNCHPAD_PUBLIC', 'true');
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://launch.example');
    for (const path of [
      '/',
      '/launch',
      '/rules',
      '/roadmap',
      '/404',
      '/token/So11111111111111111111111111111111111111112',
      '/api/coins',
      '/api/upload',
      '/api/rewards',
    ]) {
      const result = middleware(
        new NextRequest(`https://launch.example${path}`, { headers: { host: 'launch.example' } })
      );
      expect(result.status).toBe(200);
      expect(result.headers.get('x-middleware-next')).toBe('1');
      expect(result.headers.get('Content-Security-Policy')).toContain("script-src-attr 'none'");
      expect(validScriptNonce(result.headers.get(`x-middleware-request-${NONCE_HEADER}`))).toBe(
        true
      );
    }
    expect(middleware(new NextRequest('https://launch.example/api/admin/wallet')).status).toBe(401);
    expect(middleware(new NextRequest('https://launch.example/api/coins/admin')).status).toBe(401);
    const unknown = middleware(
      new NextRequest('https://launch.example/private', { headers: { host: 'launch.example' } })
    );
    expect(unknown.status).toBe(307);
    expect(unknown.headers.get('Location')).toBe('https://launch.example/');
    vi.stubEnv('LAUNCHPAD_PUBLIC', 'false');
    expect(middleware(new NextRequest('https://launch.example/api/coins')).status).toBe(401);
  });
});
