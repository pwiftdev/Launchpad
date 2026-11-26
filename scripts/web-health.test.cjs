const { test } = require('node:test');
const assert = require('node:assert/strict');
const { collectWebHealth, collectDatabaseHealth, monitorOrigin } = require('./web-health.cjs');
const origin = 'https://launch.example';
function response(path, overrides = {}) {
  const headers = {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'cache-control': 'private, no-store',
  };
  if (path === '/admin' || path === '/')
    Object.assign(headers, {
      'content-type': 'text/html',
      'content-security-policy':
        "script-src 'nonce-abcdefghijklmnopqrstuvwx' 'strict-dynamic'; style-src 'unsafe-inline'",
    });
  if (path === '/') headers.location = '/admin';
  const status =
    path === '/'
      ? 307
      : ['/api/coins', '/api/admin/config'].includes(path)
        ? 401
        : path === '/api/whitelist'
          ? 410
          : 200;
  const body =
    path === '/'
      ? '<!DOCTYPE html><title data-next-head="">MASKED | Your keys. Your launches.</title>'
      : path === '/admin'
        ? '<!DOCTYPE html><title data-next-head="">Admin | MSKD.fun</title>'
        : path === '/api/health'
          ? '{"status":"ok"}'
          : '{}';
  return new Response(overrides.body ?? body, {
    status: overrides.status ?? status,
    headers: { ...headers, ...overrides.headers },
  });
}
function fixture(changes = {}) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, options) => {
      assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'manual');
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.headers.cookie, undefined);
      const path = new URL(url).pathname;
      calls.push(path);
      if (changes[path] instanceof Error) throw changes[path];
      return response(path, changes[path]);
    },
  };
}
test('probes a closed launchpad, retired registration and private gates without authentication or writes', async () => {
  const f = fixture(),
    result = await collectWebHealth({ origin, fetchImpl: f.fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.readOnly, true);
  assert.equal(result.checks.length, 5);
  assert.equal(result.alerts.length, 0);
  assert.ok(f.calls.includes('/api/whitelist'));
});
test('flags an exposed launchpad/API, absent nonce policy and active registration as critical', async () => {
  const f = fixture({
    '/': { status: 200 },
    '/api/coins': { status: 200 },
    '/admin': { headers: { 'content-security-policy': "script-src 'unsafe-inline'" } },
    '/api/whitelist': { status: 200 },
  });
  const result = await collectWebHealth({ origin, fetchImpl: f.fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.alerts.filter((x) => x.severity === 'critical').length, 4);
});
test('rejects redirects off-site, malformed/oversized bodies and redacts provider errors', async () => {
  const f = fixture({
    '/': { headers: { location: 'https://attacker.example/admin' } },
    '/api/health': { body: 'x'.repeat(16385) },
    '/api/whitelist': new Error('private-provider-url?token=secret'),
  });
  const result = await collectWebHealth({ origin, fetchImpl: f.fetchImpl });
  assert.equal(result.ok, false);
  assert.doesNotMatch(JSON.stringify(result), /private-provider|attacker|token=secret/);
});
test('latency warnings are distinct from failure for the public launchpad', async () => {
  let clock = 0;
  const f = fixture({
    '/': { status: 200 },
    '/admin': { status: 307, headers: { location: '/' } },
  });
  const result = await collectWebHealth({
    origin,
    publicExpected: true,
    fetchImpl: f.fetchImpl,
    slowMs: 1,
    now: () => (clock += 10),
  });
  assert.equal(result.ok, true);
  assert.ok(f.calls.includes('/api/admin/config'));
  assert.ok(result.alerts.some((x) => x.code === 'WEB_PROBE_SLOW'));
});
test('fails the public health check if the admin form is still served', async () => {
  const f = fixture({ '/': { status: 200 } });
  const result = await collectWebHealth({ origin, publicExpected: true, fetchImpl: f.fetchImpl });
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.alerts.map(({ check }) => check),
    ['admin_document']
  );
});
test('origin validation rejects credentials/paths and requires explicit local rehearsal for HTTP', () => {
  for (const value of [
    'https://user:secret@launch.example',
    'https://launch.example/path',
    'https://launch.example?token=secret',
    'http://127.0.0.1:3003',
  ])
    assert.throws(() => monitorOrigin(value));
  assert.equal(monitorOrigin('http://127.0.0.1:3003', true), 'http://127.0.0.1:3003');
  assert.throws(() => monitorOrigin('http://remote.example', true));
});
test('an actual stalled HTTP body is aborted within the bounded probe window', async () => {
  const { createServer } = require('node:http');
  const server = createServer(async (request, reply) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const prepared = response(pathname);
    reply.writeHead(prepared.status, Object.fromEntries(prepared.headers));
    if (pathname === '/api/health') reply.write('{');
    else reply.end(await prepared.text());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const start = Date.now();
    const report = await collectWebHealth({
      origin: `http://127.0.0.1:${server.address().port}`,
      allowLocal: true,
      timeoutMs: 100,
      slowMs: 50,
    });
    assert.equal(report.checks.find((check) => check.name === 'health').ok, false);
    assert.ok(
      report.alerts.some(
        (alert) => alert.check === 'health' && alert.code === 'WEB_PROBE_UNAVAILABLE'
      )
    );
    assert.ok(Date.now() - start < 2000);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
function databaseFixture({ tls = true, missing = [], failure = false } = {}) {
  const statements = [];
  return {
    statements,
    pool: {
      connect: async () => ({
        async query(sql) {
          statements.push(sql);
          assert.match(sql, /^(BEGIN READ ONLY|SET LOCAL|SELECT|ROLLBACK)/);
          if (sql.startsWith('SELECT current_setting')) {
            if (failure) throw new Error('private-database-password');
            return { rows: [{ read_only: 'on', tls }] };
          }
          return { rows: missing.map((name) => ({ name })) };
        },
        release() {
          statements.push('RELEASE');
        },
      }),
    },
  };
}
test('database readiness verifies TLS/schema in a read-only transaction and always releases it', async () => {
  const f = databaseFixture(),
    result = await collectDatabaseHealth({ pool: f.pool });
  assert.equal(result.ok, true);
  assert.deepEqual(f.statements.slice(-2), ['ROLLBACK', 'RELEASE']);
  for (const options of [{ tls: false }, { missing: ['launch_coins'] }, { failure: true }]) {
    const broken = databaseFixture(options),
      report = await collectDatabaseHealth({ pool: broken.pool });
    assert.equal(report.ok, false);
    assert.deepEqual(broken.statements.slice(-2), ['ROLLBACK', 'RELEASE']);
    assert.doesNotMatch(JSON.stringify(report), /private-database-password/);
  }
});
