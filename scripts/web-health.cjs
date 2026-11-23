/* Read-only campaign/service monitoring. This command never signs, sends transactions or alerts people. */
const { performance } = require('node:perf_hooks');

function monitorOrigin(value, allowLocal = false) {
  const url = new URL(value);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    (url.protocol !== 'https:' && !(allowLocal && local && url.protocol === 'http:'))
  )
    throw new Error('Monitoring requires a canonical HTTPS origin');
  return url.origin;
}
async function boundedBody(response, maximum) {
  if (!response.body) throw new Error('Missing response');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new Error('Probe response exceeds capacity');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await reader.cancel().catch(() => {});
  }
}
function hardened(headers) {
  return (
    headers.get('x-content-type-options')?.toLowerCase() === 'nosniff' &&
    headers.get('x-frame-options')?.toUpperCase() === 'DENY'
  );
}
function noncePolicy(headers) {
  const script =
    (headers.get('content-security-policy') ?? '')
      .split(';')
      .map((x) => x.trim())
      .find((x) => x.startsWith('script-src ')) ?? '';
  return (
    /'nonce-[A-Za-z0-9+/_-]{20,}={0,2}'/.test(script) &&
    script.includes("'strict-dynamic'") &&
    !script.includes("'unsafe-eval'") &&
    !script.includes("'unsafe-inline'")
  );
}

async function collectWebHealth({
  origin,
  allowLocal = false,
  registrationExpected = true,
  timeoutMs = 5000,
  slowMs = 1500,
  fetchImpl = fetch,
  now = () => performance.now(),
}) {
  origin = monitorOrigin(origin, allowLocal);
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 50 ||
    timeoutMs > 10000 ||
    !Number.isSafeInteger(slowMs) ||
    slowMs < 1 ||
    slowMs > timeoutMs
  )
    throw new Error('Invalid monitoring time limits');
  const alerts = [];
  const specs = [
    {
      name: 'health',
      path: '/api/health',
      maximum: 16384,
      valid: (r, body) =>
        r.status === 200 && hardened(r.headers) && JSON.parse(body).status === 'ok',
    },
    {
      name: 'whitelist_document',
      path: '/whitelist',
      maximum: 262144,
      valid: (r, body) =>
        r.status === 200 &&
        hardened(r.headers) &&
        noncePolicy(r.headers) &&
        r.headers.get('content-type')?.includes('text/html') &&
        /<title\b[^>]*>[^<]*RINSED/i.test(body),
    },
    {
      name: 'public_gate',
      path: '/',
      maximum: 16384,
      valid: (r) => {
        const location = new URL(r.headers.get('location') ?? '', origin);
        return r.status === 307 && location.origin === origin && location.pathname === '/whitelist';
      },
    },
    {
      name: 'private_api_gate',
      path: '/api/coins',
      maximum: 16384,
      valid: (r) => r.status === 401 && /no-store/i.test(r.headers.get('cache-control') ?? ''),
    },
    {
      name: 'registration',
      path: '/api/whitelist',
      maximum: 16384,
      valid: (r, body) =>
        !registrationExpected
          ? r.status === 503
          : r.status === 200 &&
            JSON.parse(body).registration === null &&
            Number.isSafeInteger(JSON.parse(body).count),
    },
  ];
  const checks = await Promise.all(
    specs.map(async (spec) => {
      const start = now();
      let httpStatus = null,
        response;
      try {
        response = await fetchImpl(origin + spec.path, {
          method: 'GET',
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
          headers: { 'user-agent': 'Rinsed-ReadOnly-Monitor/1' },
        });
        httpStatus = response.status;
        const body = await boundedBody(response, spec.maximum);
        const ok = !!spec.valid(response, body);
        const latencyMs = Math.max(0, Math.round(now() - start));
        if (!ok) alerts.push({ severity: 'critical', code: 'WEB_PROBE_FAILED', check: spec.name });
        else if (latencyMs > slowMs)
          alerts.push({ severity: 'warning', code: 'WEB_PROBE_SLOW', check: spec.name, latencyMs });
        return { name: spec.name, ok, httpStatus, latencyMs };
      } catch {
        await response?.body?.cancel().catch(() => {});
        alerts.push({ severity: 'critical', code: 'WEB_PROBE_UNAVAILABLE', check: spec.name });
        return {
          name: spec.name,
          ok: false,
          httpStatus,
          latencyMs: Math.max(0, Math.round(now() - start)),
        };
      }
    })
  );
  if (!registrationExpected)
    alerts.push({ severity: 'warning', code: 'REGISTRATION_INTENTIONALLY_DISABLED' });
  return {
    checkedAt: new Date().toISOString(),
    readOnly: true,
    scope: 'Whitelist campaign and private launchpad gate',
    registrationExpected,
    ok: !alerts.some((a) => a.severity === 'critical'),
    checks,
    alerts,
  };
}

async function collectDatabaseHealth({
  pool,
  requiredTables = ['whitelist_entries', 'whitelist_challenges', 'whitelist_limits'],
  slowMs = 1000,
  now = () => performance.now(),
}) {
  if (
    !Array.isArray(requiredTables) ||
    requiredTables.length > 32 ||
    requiredTables.some((name) => typeof name !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(name))
  )
    throw new Error('Invalid monitoring table requirements');
  if (!Number.isSafeInteger(slowMs) || slowMs < 1 || slowMs > 10000)
    throw new Error('Invalid database latency limit');
  const start = now(),
    alerts = [];
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout='5000ms'");
    const transport = (
      await client.query(
        "SELECT current_setting('transaction_read_only') AS read_only,(SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS tls"
      )
    ).rows[0];
    if (transport?.read_only !== 'on' || transport?.tls !== true)
      alerts.push({ severity: 'critical', code: 'DATABASE_READONLY_TLS_REQUIRED' });
    const missing = (
      await client.query(
        "SELECT name FROM unnest($1::text[]) AS name WHERE to_regclass('public.'||name) IS NULL",
        [requiredTables]
      )
    ).rows;
    if (missing.length)
      alerts.push({
        severity: 'critical',
        code: 'DATABASE_SCHEMA_MISSING',
        tables: missing.map((row) => row.name),
      });
  } catch {
    alerts.push({ severity: 'critical', code: 'DATABASE_CHECK_FAILED' });
  } finally {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch {
        alerts.push({ severity: 'critical', code: 'DATABASE_CHECK_FAILED' });
      } finally {
        client.release();
      }
    }
  }
  const latencyMs = Math.max(0, Math.round(now() - start));
  if (!alerts.length && latencyMs > slowMs)
    alerts.push({ severity: 'warning', code: 'DATABASE_CHECK_SLOW', latencyMs });
  return { readOnly: true, ok: !alerts.some((a) => a.severity === 'critical'), latencyMs, alerts };
}

async function main() {
  if (process.argv.slice(2).some((arg) => arg !== '--local') || process.argv.length > 3)
    throw new Error('Only --local is accepted for explicit loopback rehearsal');
  const allowLocal = process.argv[2] === '--local';
  if (allowLocal && process.env.NODE_ENV === 'production')
    throw new Error('Local monitoring flag is unavailable in production');
  const web = await collectWebHealth({
    origin: process.env.NEXT_PUBLIC_SITE_URL,
    allowLocal,
    registrationExpected: process.env.WHITELIST_ENABLED === 'true',
    slowMs: Number(process.env.WEB_HEALTH_SLOW_MS || 1500),
  });
  let database = null,
    pool;
  try {
    if (process.env.DATABASE_URL) {
      const { createRequire } = require('node:module'),
        path = require('node:path');
      const appRequire = createRequire(
        path.resolve(__dirname, '../scaffolds/fun-launch/package.json')
      );
      const { Pool } = appRequire('pg'),
        { databaseConfig } = require('./postgres-config.cjs');
      pool = new Pool({ ...databaseConfig(), max: 1, application_name: 'rinsed-web-health' });
      pool.on('error', () => {});
      database = await collectDatabaseHealth({ pool });
    } else if (
      process.env.WHITELIST_ENABLED === 'true' ||
      process.env.FINANCIAL_WORKER_ENABLED === 'true'
    )
      database = {
        ok: false,
        readOnly: true,
        alerts: [{ severity: 'critical', code: 'DATABASE_CONFIGURATION_MISSING' }],
      };
    const result = {
      checkedAt: web.checkedAt,
      readOnly: true,
      ok: web.ok && database?.ok !== false,
      web,
      database,
    };
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 2;
  } finally {
    await pool?.end();
  }
}
module.exports = { collectWebHealth, collectDatabaseHealth, monitorOrigin };
if (require.main === module)
  main().catch(() => {
    console.error(
      JSON.stringify({
        ok: false,
        code: 'WEB_HEALTH_CHECK_FAILED',
        note: 'Check private monitor configuration; provider details are withheld.',
      })
    );
    process.exitCode = 1;
  });
