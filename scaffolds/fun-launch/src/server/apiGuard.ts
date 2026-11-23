import type { NextApiRequest, NextApiResponse } from 'next';
import { isIP } from 'node:net';
import { accessPath, launchpadIsPublic, publicApi } from '@/lib/accessRoutes';
import { ADMIN_COOKIE, readAdminSession } from './adminSession';
import { siteOrigins } from './siteOrigin';

// Process-local protection. Use one web process and an edge limiter before scaling out.
type Bucket = { count: number; until: number };
const buckets = new Map<string, Bucket>();
// Read traffic cannot consume write admission counters or their bounded storage.
const marketBuckets = new Map<string, Bucket>();
const MAX_BUCKETS = 10_000;

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

/** Exact known market reads only: quotes, receipts, rewards, profiles and writes retain the stricter budget. */
function marketRead(req: NextApiRequest): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const path = accessPath(req.url ?? '');
  return (
    [
      '/api/coins',
      '/api/trending',
      '/api/market-stats',
      '/api/sol-price',
      '/api/burns',
      '/api/token-image',
    ].includes(path) ||
    /^\/api\/coins\/[1-9A-HJ-NP-Za-km-z]{32,44}(?:\/(?:trades|holders|live))?$/.test(path)
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
  if (!publicApi(req.url ?? '', launchpadIsPublic())) {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Vary', 'Cookie');
    if (!readAdminSession(req.cookies?.[ADMIN_COOKIE])) {
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
  const limits = marketRead(req)
    ? // At ~180 reads/minute per live viewer, accommodate multiple tabs while bounding cached-read bursts.
      admit(
        [
          { key: 'market:all:minute', limit: 12_000, windowMs: 60_000 },
          { key: 'market:all:burst', limit: 1_000, windowMs: 5_000 },
          { key: `market:${ip}:minute`, limit: 900, windowMs: 60_000 },
          { key: `market:${ip}:burst`, limit: 80, windowMs: 5_000 },
        ],
        marketBuckets
      )
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
