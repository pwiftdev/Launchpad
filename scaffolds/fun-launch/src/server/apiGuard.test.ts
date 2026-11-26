import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import adminSessionHandler from '@/pages/api/admin/session';
import { apiGuard, clientIp, takeLimit } from './apiGuard';
import { ADMIN_COOKIE, signAdminSession } from './adminSession';

const request = (headers = {}) =>
  ({
    method: 'POST',
    url: '/api/admin/session',
    headers,
    socket: { remoteAddress: '127.0.0.1' },
  }) as NextApiRequest;
function response() {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return res as unknown as NextApiResponse;
}
let testTime = Date.UTC(2026, 0, 1);
beforeEach(() => {
  testTime += 120_000;
  vi.spyOn(Date, 'now').mockReturnValue(testTime);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function admittedRequest(url = '/api/coins', method = 'GET', ip = '192.0.2.1') {
  vi.stubEnv('ADMIN_KEY_HASH', `pbkdf2-sha256$600000$${'a'.repeat(32)}$${'b'.repeat(64)}`);
  vi.stubEnv('ADMIN_SESSION_SECRET', 'test-only-session-secret-that-is-over-32-characters');
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://launch.example');
  const req = request({ origin: 'https://launch.example', 'content-type': 'application/json' });
  req.url = url;
  req.method = method;
  req.socket = { remoteAddress: ip } as NextApiRequest['socket'];
  req.cookies = { [ADMIN_COOKIE]: signAdminSession() };
  return req;
}

describe('API guard', () => {
  it.each(['/api/upload', '/api/launch-previews'])(
    'enforces access on %s without middleware',
    (url) => {
      vi.stubEnv('LAUNCHPAD_PUBLIC', 'false');
      const req = admittedRequest(url, 'POST');
      expect(apiGuard(req, response())).toBe(true);
      req.cookies = {};
      const unauthorized = response();
      expect(apiGuard(req, unauthorized)).toBe(false);
      expect(unauthorized.status).toHaveBeenCalledWith(401);
      vi.stubEnv('LAUNCHPAD_PUBLIC', 'true');
      expect(apiGuard(req, response())).toBe(true);
      req.headers.origin = 'https://wrong.example';
      const crossOrigin = response();
      expect(apiGuard(req, crossOrigin)).toBe(false);
      expect(crossOrigin.status).toHaveBeenCalledWith(403);
    }
  );
  it('retires admin sign-in and rejects existing admin sessions on private APIs in public mode', async () => {
    vi.stubEnv('LAUNCHPAD_PUBLIC', 'true');
    for (const method of ['GET', 'POST']) {
      const retired = response();
      await adminSessionHandler(admittedRequest('/api/admin/session', method), retired);
      expect(retired.status).toHaveBeenCalledWith(404);
      expect(retired.setHeader).not.toHaveBeenCalledWith('Set-Cookie', expect.anything());
    }
    const privateApi = response();
    expect(apiGuard(admittedRequest('/api/admin/config'), privateApi)).toBe(false);
    expect(privateApi.status).toHaveBeenCalledWith(401);
  });
  it('admits public user APIs without an admin cookie while preserving origin checks and private routes', () => {
    vi.stubEnv('LAUNCHPAD_PUBLIC', 'true');
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://launch.example');
    for (const url of ['/api/coins', '/api/callouts', '/api/rewards', '/api/launch/status']) {
      const req = request();
      req.url = url;
      req.method = 'GET';
      expect(apiGuard(req, response())).toBe(true);
    }
    const write = request({ origin: 'https://launch.example', 'content-type': 'application/json' });
    write.url = '/api/upload';
    expect(apiGuard(write, response())).toBe(true);
    write.headers.origin = 'https://evil.example';
    const blocked = response();
    expect(apiGuard(write, blocked)).toBe(false);
    expect(blocked.status).toHaveBeenCalledWith(403);
    for (const url of ['/api/admin/wallet', '/api/launch/admin', '/api/unknown']) {
      const req = request();
      req.url = url;
      req.method = 'GET';
      const result = response();
      expect(apiGuard(req, result)).toBe(false);
      expect(result.status).toHaveBeenCalledWith(401);
    }
    vi.stubEnv('LAUNCHPAD_PUBLIC', 'false');
    const closed = request();
    closed.url = '/api/coins';
    closed.method = 'GET';
    expect(apiGuard(closed, response())).toBe(false);
  });
  it('allows a configured custom domain but rejects lookalike origins', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://launch.example');
    vi.stubEnv('SITE_ALLOWED_ORIGINS', 'https://rinsed.fun');
    expect(
      apiGuard(
        request({ origin: 'https://rinsed.fun', 'content-type': 'application/json' }),
        response()
      )
    ).toBe(true);
    const res = response();
    expect(
      apiGuard(
        request({
          origin: 'https://rinsed.fun.attacker.example',
          'content-type': 'application/json',
        }),
        res
      )
    ).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
  });
  it('protects private data even when a request tries to skip middleware', () => {
    const req = request({ 'x-middleware-subrequest': 'middleware:middleware:middleware' });
    req.url = '/api/coins';
    req.method = 'GET';
    const res = response();
    expect(apiGuard(req, res)).toBe(false);
    expect(res.status).toHaveBeenCalledWith(401);
  });
  it('allows a private API only with a signed admin session', () => {
    vi.stubEnv('ADMIN_KEY_HASH', `pbkdf2-sha256$600000$${'a'.repeat(32)}$${'b'.repeat(64)}`);
    vi.stubEnv('ADMIN_SESSION_SECRET', 'test-only-session-secret-that-is-over-32-characters');
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://launch.example');
    const req = request();
    req.url = '/api/coins';
    req.method = 'GET';
    req.cookies = { [ADMIN_COOKIE]: signAdminSession() };
    expect(apiGuard(req, response())).toBe(true);
    req.cookies[ADMIN_COOKIE] += 'tampered';
    expect(apiGuard(req, response())).toBe(false);
  });
  it('rejects cross-site writes and non-JSON writes', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://launch.example');
    const res = response();
    expect(
      apiGuard(
        request({ origin: 'https://attacker.example', 'content-type': 'application/json' }),
        res
      )
    ).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(apiGuard(request({ 'content-type': 'text/plain' }), res)).toBe(false);
    expect(res.status).toHaveBeenCalledWith(415);
  });
  it('uses Heroku’s appended client address, not a forged first entry', () => {
    vi.stubEnv('DYNO', 'web.1');
    expect(clientIp(request({ 'x-forwarded-for': '1.2.3.4, 203.0.113.4' }))).toBe('203.0.113.4');
    vi.stubEnv('DYNO', '');
    expect(clientIp(request({ 'x-forwarded-for': '1.2.3.4' }))).toBe('127.0.0.1');
  });
  it('limits attempts and resets after the window expires', () => {
    const time = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    expect(takeLimit('test-window', 1, 100)).toBe(true);
    expect(takeLimit('test-window', 1, 100)).toBe(false);
    time.mockReturnValue(1_101);
    expect(takeLimit('test-window', 1, 100)).toBe(true);
    time.mockRestore();
  });
  it('supports sustained market polling from 30 viewers beyond the old shared 1200/minute ceiling', () => {
    const viewers = Array.from({ length: 30 }, (_, index) =>
      admittedRequest(
        `/api/coins/${'1'.repeat(32)}/${index % 2 ? 'trades' : 'holders'}`,
        'GET',
        `192.0.2.${index + 1}`
      )
    );
    // 180 requests/minute/viewer, including live invalidations; no mutation counter is used.
    for (let second = 0; second < 60; second++) {
      vi.mocked(Date.now).mockReturnValue(testTime + second * 1000);
      for (const viewer of viewers)
        for (let n = 0; n < 3; n++) expect(apiGuard(viewer, response())).toBe(true);
    }
    expect(apiGuard(admittedRequest('/api/admin/session', 'POST'), response())).toBe(true);
  });
  it('keeps writes independent of market and interactive reads', () => {
    const write = admittedRequest('/api/admin/session', 'POST');
    for (let n = 0; n < 240; n++) expect(apiGuard(write, response())).toBe(true);
    const writeRes = response();
    expect(apiGuard(write, writeRes)).toBe(false);
    expect(writeRes.status).toHaveBeenCalledWith(429);
    expect(apiGuard(admittedRequest('/api/coins'), response())).toBe(true);
    expect(apiGuard(admittedRequest('/api/profiles?wallets=test'), response())).toBe(true);
    expect(apiGuard(admittedRequest('/api/profiles', 'POST'), response())).toBe(false);
  });
  it('uses only exact known polling GET/HEAD routes', () => {
    const control = admittedRequest('/api/admin/session', 'POST');
    for (let n = 0; n < 240; n++) expect(apiGuard(control, response())).toBe(true);
    for (const route of [
      '/api/coins',
      '/api/coins/?query=1',
      '/api/trending',
      '/api/market-stats',
      '/api/sol-price',
      '/api/burns',
      `/api/coins/${'1'.repeat(32)}`,
      `/api/coins/${'1'.repeat(32)}/live`,
      '/api/quote',
      '/api/rewards',
      '/api/launch/status',
      '/api/transaction-status',
      '/api/callouts',
    ])
      expect(apiGuard(admittedRequest(route, 'GET'), response())).toBe(true);
    expect(apiGuard(admittedRequest('/api/coins', 'HEAD'), response())).toBe(true);
    for (const route of [
      '/api/coins-attacker',
      '/api/coins/bad-mint/trades',
      `/api/coins/${'1'.repeat(32)}/trades/extra`,
      '/api/rewards/admin',
      '/api/launch/confirm',
    ])
      expect(apiGuard(admittedRequest(route), response())).toBe(false);
    expect(apiGuard(admittedRequest('/api/coins', 'POST'), response())).toBe(false);
  });
  it('admits a minute of synchronized quote, balance and reward polling from 200 users', () => {
    const viewers = Array.from({ length: 200 }, (_, index) => {
      const ip = `192.0.2.${index + 1}`;
      return [
        admittedRequest('/api/quote', 'GET', ip),
        admittedRequest('/api/rewards', 'GET', ip),
        admittedRequest(`/api/coins/${'1'.repeat(32)}/balance`, 'GET', ip),
      ] as const;
    });
    for (let second = 0; second < 60; second += 3) {
      vi.mocked(Date.now).mockReturnValue(testTime + second * 1000);
      for (const [quote, rewards, balance] of viewers) {
        expect(apiGuard(quote, response())).toBe(true);
        if (second % 15 === 0) {
          expect(apiGuard(rewards, response())).toBe(true);
          expect(apiGuard(balance, response())).toBe(true);
        }
      }
    }
    expect(apiGuard(admittedRequest('/api/send-transaction', 'POST'), response())).toBe(true);
  });
  it('caps aggregate interactive polling bursts without consuming write capacity', () => {
    for (let viewer = 0; viewer < 20; viewer++) {
      const req = admittedRequest('/api/quote', 'GET', `198.51.100.${viewer + 1}`);
      for (let n = 0; n < 40; n++) expect(apiGuard(req, response())).toBe(true);
    }
    const res = response();
    expect(apiGuard(admittedRequest('/api/rewards', 'GET', '198.51.100.99'), res)).toBe(false);
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '5');
    expect(apiGuard(admittedRequest('/api/send-transaction', 'POST'), response())).toBe(true);
  });
  it('bounds market IP bursts and reports the remaining retry time instead of always 60 seconds', () => {
    const req = admittedRequest();
    for (let n = 0; n < 80; n++) expect(apiGuard(req, response())).toBe(true);
    vi.mocked(Date.now).mockReturnValue(testTime + 1201);
    const res = response();
    expect(apiGuard(req, res)).toBe(false);
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '4');
    vi.mocked(Date.now).mockReturnValue(testTime + 5000);
    expect(apiGuard(req, response())).toBe(true);
    // The 80 market calls do not reduce the original 240 mutation allowance.
    const write = admittedRequest('/api/admin/session', 'POST');
    for (let n = 0; n < 240; n++) expect(apiGuard(write, response())).toBe(true);
  });
  it('bounds sustained per-IP reads even when the short burst windows have reset', () => {
    const req = admittedRequest();
    for (let batch = 0; batch < 12; batch++) {
      vi.mocked(Date.now).mockReturnValue(testTime + batch * 5000);
      for (let n = 0; n < (batch === 11 ? 20 : 80); n++)
        expect(apiGuard(req, response())).toBe(true);
    }
    const res = response();
    expect(apiGuard(req, res)).toBe(false);
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '5');
    expect(apiGuard(admittedRequest('/api/coins', 'GET', '192.0.2.2'), response())).toBe(true);
    vi.mocked(Date.now).mockReturnValue(testTime + 60000);
    expect(apiGuard(req, response())).toBe(true);
  });
  it('does not charge global admission for repeated denied requests from a throttled IP', () => {
    const spam = admittedRequest();
    for (let n = 0; n < 80; n++) expect(apiGuard(spam, response())).toBe(true);
    for (let n = 0; n < 1500; n++) expect(apiGuard(spam, response())).toBe(false);
    // Without atomic admission the repeated denials would exhaust the 1000-request process burst.
    expect(apiGuard(admittedRequest('/api/coins', 'GET', '192.0.2.2'), response())).toBe(true);
    const write = admittedRequest('/api/admin/session', 'POST', '192.0.2.3');
    for (let n = 0; n < 240; n++) expect(apiGuard(write, response())).toBe(true);
    for (let n = 0; n < 1500; n++) expect(apiGuard(write, response())).toBe(false);
    expect(apiGuard(admittedRequest('/api/admin/session', 'POST', '192.0.2.4'), response())).toBe(
      true
    );
  });
  it('bounds aggregate market bursts without blocking writes and leaves auth/origin protection intact', () => {
    for (let viewer = 0; viewer < 20; viewer++) {
      const req = admittedRequest('/api/coins', 'GET', `198.51.100.${viewer + 1}`);
      for (let n = 0; n < 50; n++) expect(apiGuard(req, response())).toBe(true);
    }
    const res = response();
    expect(apiGuard(admittedRequest('/api/coins', 'GET', '198.51.100.99'), res)).toBe(false);
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '5');
    expect(apiGuard(admittedRequest('/api/admin/session', 'POST'), response())).toBe(true);
    const anonymous = admittedRequest();
    anonymous.cookies = {};
    const unauthorized = response();
    expect(apiGuard(anonymous, unauthorized)).toBe(false);
    expect(unauthorized.status).toHaveBeenCalledWith(401);
    const crossSite = admittedRequest('/api/coins', 'POST');
    crossSite.headers.origin = 'https://attacker.example';
    const denied = response();
    expect(apiGuard(crossSite, denied)).toBe(false);
    expect(denied.status).toHaveBeenCalledWith(403);
  });
  it('retains the original aggregate protected budget and accurate remaining minute retry', () => {
    for (let client = 0; client < 6; client++) {
      const req = admittedRequest('/api/admin/session', 'POST', `203.0.113.${client + 1}`);
      for (let n = 0; n < 200; n++) expect(apiGuard(req, response())).toBe(true);
    }
    vi.mocked(Date.now).mockReturnValue(testTime + 22_100);
    const res = response();
    expect(apiGuard(admittedRequest('/api/send-transaction', 'POST', '203.0.113.99'), res)).toBe(
      false
    );
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '38');
    expect(apiGuard(admittedRequest('/api/coins'), response())).toBe(true);
    vi.mocked(Date.now).mockReturnValue(testTime + 60_000);
    expect(apiGuard(admittedRequest('/api/admin/session', 'POST'), response())).toBe(true);
  });
});
