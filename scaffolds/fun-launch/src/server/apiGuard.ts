import type { NextApiRequest, NextApiResponse } from 'next';
import { isIP } from 'node:net';
import { accessPath, launchpadIsPublic, publicApi } from '@/lib/accessRoutes';
import { ADMIN_COOKIE, readAdminSession } from './adminSession';
import { siteOrigins } from './siteOrigin';

// Process-local protection. Use one web process and an edge limiter before scaling out.
type Bucket = { count: number; until: number };
const buckets = new Map<string, Bucket>();
// Read traffic cannot consume write admission counters or their bounded storage.
const pollingBuckets = new Map<string, Bucket>();
const MAX_BUCKETS = 10_000;
const POLLING_LIMITS = {
  market: { minute: 12_000, burst: 1000, ipMinute: 900, ipBurst: 80 },
  interactive: { minute: 6000, burst: 800, ipMinute: 180, ipBurst: 40 },
};

type Limit = { key: string; limit: number; windowMs: number };
type Admission = { allowed: boolean; retryAfter: number };

/** Check the whole request budget before charging any counter. Denied IPs cannot drain global capacity. */
function admit(limits: Limit[], store: Map<string, Bucket>): Admission {
  const now = Date.now();
  let retryAt = 0;
  for (const rule of limits) {
    const entry = store.get(rule.key);
    if (entry && entry.until > now && entry.count >= rule.limit)
      retryAt = Math.max(retryAt, entry.until);
  }
  if (retryAt)
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((retryAt - now) / 1000)) };

  let missing = limits.filter((rule) => !store.has(rule.key)).length;
  if (store.size + missing > MAX_BUCKETS) {
    for (const [key, value] of store) if (value.until <= now) store.delete(key);
    missing = limits.filter((rule) => !store.has(rule.key)).length;
    if (store.size + missing > MAX_BUCKETS) {
      const wanted = new Set(limits.map((rule) => rule.key));
      const expiries = [...store]
        .filter(([key]) => !wanted.has(key))
        .map(([, entry]) => entry.until)
        .sort((a, b) => a - b);
      const until = expiries[store.size + missing - MAX_BUCKETS - 1] ?? now + 60_000;
      return { allowed: false, retryAfter: Math.max(1, Math.ceil((until - now) / 1000)) };
    }
  }
  for (const rule of limits) {
    const entry = store.get(rule.key);
    if (!entry || entry.until <= now) store.set(rule.key, { count: 1, until: now + rule.windowMs });
    else entry.count += 1;
  }
  return { allowed: true, retryAfter: 0 };
}

export function takeLimit(key: string, limit: number, windowMs: number): boolean {
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(windowMs) || windowMs < 1)
    return false;
  return admit([{ key, limit, windowMs }], buckets).allowed;
}

function pollingClass(req: NextApiRequest): keyof typeof POLLING_LIMITS | undefined {
  if (req.method !== 'GET' && req.method !== 'HEAD') return;
  const path = accessPath(req.url ?? '');
  if (
    [
      '/api/coins',
      '/api/trending',
      '/api/market-stats',
      '/api/solana-market',
      '/api/sol-price',
      '/api/token-image',
    ].includes(path) ||
    /^\/api\/coins\/[1-9A-HJ-NP-Za-km-z]{32,44}(?:\/(?:trades|holders|live))?$/.test(path)
  )
    return 'market';
  if (
    [
      '/api/quote',
      '/api/dev-buy-quote',
      '/api/transaction-status',
      '/api/launch/status',
      '/api/launch/receipt-status',
      '/api/rewards',
    ].includes(path) ||
    /^\/api\/coins\/[1-9A-HJ-NP-Za-km-z]{32,44}\/balance$/.test(path)
  )
    return 'interactive';
  return undefined;
}

function admitPolling(kind: keyof typeof POLLING_LIMITS, ip: string): Admission {
  const { minute, burst, ipMinute, ipBurst } = POLLING_LIMITS[kind];
  return admit(
    [
      { key: `${kind}:all:minute`, limit: minute, windowMs: 60_000 },
      { key: `${kind}:all:burst`, limit: burst, windowMs: 5000 },
      { key: `${kind}:${ip}:minute`, limit: ipMinute, windowMs: 60_000 },
      { key: `${kind}:${ip}:burst`, limit: ipBurst, windowMs: 5000 },
    ],
    pollingBuckets
  );
}

export function clientIp(req: NextApiRequest): string {
  // Heroku appends the connecting address. Never trust the client-supplied first entry.
  const forwarded = req.headers['x-forwarded-for'];
  const last = typeof forwarded === 'string' ? forwarded.split(',').at(-1)?.trim() : '';
  return process.env.DYNO && last && isIP(last) ? last : (req.socket.remoteAddress ?? 'unknown');
}

export function apiGuard(req: NextApiRequest, res: NextApiResponse): boolean {
  // Enforce authorization again in each handler, even if middleware is skipped.
  const open = launchpadIsPublic();
  if (!publicApi(req.url ?? '', open)) {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Vary', 'Cookie');
    if (open || !readAdminSession(req.cookies?.[ADMIN_COOKIE])) {
      res.status(401).json({ error: 'Admin access required' });
      return false;
    }
  }
  const mutating = req.method !== 'GET' && req.method !== 'HEAD';
  if (mutating) {
    res.setHeader('Cache-Control', 'no-store');
    const origin = req.headers.origin;
    const expected = siteOrigins();
    if (req.headers['sec-fetch-site'] === 'cross-site' || (origin && !expected.includes(origin))) {
      res.status(403).json({ error: 'Request origin is not allowed' });
      return false;
    }
    if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) {
      res.status(415).json({ error: 'Use application/json' });
      return false;
    }
  }
  const ip = clientIp(req);
  const polling = pollingClass(req);
  const limits = polling
    ? admitPolling(polling, ip)
    : admit(
        [
          { key: 'all-api', limit: 1200, windowMs: 60_000 },
          { key: `api:${ip}`, limit: 240, windowMs: 60_000 },
        ],
        buckets
      );
  if (!limits.allowed) {
    res.setHeader('Retry-After', String(limits.retryAfter));
    res.status(429).json({ error: 'Too many requests. Try again shortly.' });
    return false;
  }
  return true;
}
