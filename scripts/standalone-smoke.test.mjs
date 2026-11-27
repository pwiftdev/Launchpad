// Run against the Linux artifact in CI; no wallets, RPC requests or uploads are needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

test(
  'Heroku standalone server serves pages and rejects invalid API requests',
  { timeout: 60_000 },
  async () => {
    const child = spawn(process.execPath, ['scripts/start.mjs'], {
      env: {
        ...process.env,
        PORT: '3107',
        LAUNCHPAD_PUBLIC: 'false',
        ADMIN_KEY_HASH: '',
        ADMIN_SESSION_SECRET: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data) => {
      output += data.toString();
    });
    child.stderr.on('data', (data) => {
      output += data.toString();
    });
    const base = 'http://127.0.0.1:3107';
    try {
      let ready = false;
      for (let i = 0; i < 60; i++) {
        if (child.exitCode !== null) throw new Error(`Standalone exited: ${output}`);
        const health = await fetch(`${base}/api/health`).catch(() => null);
        if (health?.ok) {
          ready = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      assert.ok(ready, `Standalone failed to become ready: ${output}`);
      const display = await fetch(`${base}/api/health?check=display`);
      assert.equal(display.status, 503);
      assert.deepEqual(await display.json(), { status: 'unavailable' });
      for (const url of ['/privacy', '/admin', '/logo.svg']) {
        const response = await fetch(base + url);
        assert.equal(response.status, 200, url);
        assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
        assert.equal(response.headers.get('x-frame-options'), 'DENY');
      }
      for (const url of ['/', '/launch', '/rules', '/burns', '/token/example']) {
        const response = await fetch(base + url, { redirect: 'manual' });
        assert.equal(response.status, 307, url);
        assert.ok(response.headers.get('location').endsWith('/admin'));
      }
      for (const url of ['/api/upload', '/api/swap-tx', '/api/send-transaction']) {
        const response = await fetch(base + url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: 'null',
        });
        assert.equal(response.status, 401, url);
      }
      const rejected = await fetch(`${base}/api/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example' },
        body: '{}',
      });
      assert.equal(rejected.status, 401);
      for (const url of ['/api/coins', '/api/quote', '/api/market-stats']) {
        const response = await fetch(base + url, {
          headers: {
            'x-middleware-subrequest': 'middleware:middleware:middleware:middleware:middleware',
          },
        });
        assert.equal(response.status, 401, url);
      }
      for (const url of ['/whitelist', '/w/ABCD2345']) {
        const retired = await fetch(base + url, { redirect: 'manual' });
        assert.equal(retired.status, 308, url);
        assert.equal(retired.headers.get('location'), '/');
      }
      const retiredApi = await fetch(base + '/api/whitelist');
      assert.equal(retiredApi.status, 410);
      assert.equal(retiredApi.headers.get('cache-control'), 'no-store');
      const redirect = await fetch(`${base}/create-pool`, { redirect: 'manual' });
      assert.equal(redirect.status, 308);
      assert.equal(redirect.headers.get('location'), '/launch');
    } finally {
      child.kill('SIGTERM');
    }
  }
);
