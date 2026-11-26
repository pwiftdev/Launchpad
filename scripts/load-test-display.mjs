// Local load test for the display index: many viewers on the live streams while simulated
// coin updates arrive through Postgres. Run against a local server only, never production.
//
//   node scripts/load-test-display.mjs --url http://localhost:3000 --viewers 1000 --coin-viewers 200 \
//     --seconds 60 --events-per-second 5
//
// The server must trust X-Forwarded-For (DYNO set) so each simulated viewer has its own address,
// and DATABASE_URL/DATABASE_SSL_CA must point at the same local database the server reads.
import { createRequire } from 'node:module';
import { databaseConfig } from './postgres-config.cjs';
const require = createRequire(new URL('../scaffolds/fun-launch/package.json', import.meta.url));
const { Client } = require('pg');

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, all) => {
    if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1]]);
    return pairs;
  }, [])
);
const base = new URL(args.url ?? 'http://localhost:3000');
if (!['localhost', '127.0.0.1'].includes(base.hostname)) throw new Error('Local servers only');
const viewers = Number(args.viewers ?? 1000),
  coinViewers = Number(args['coin-viewers'] ?? 200),
  seconds = Number(args.seconds ?? 60),
  rate = Number(args['events-per-second'] ?? 5);
// Node's built-in fetch opens as many connections per origin as needed.

const percentile = (values, p) =>
  values.length
    ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))]
    : null;
const ip = (n) => `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
const stats = { requests: [], errors: {}, events: 0, lags: [], streamsOpen: 0, streamFailures: 0 };
const fail = (key) => (stats.errors[key] = (stats.errors[key] ?? 0) + 1);

async function get(path, viewer) {
  const began = performance.now();
  try {
    const response = await fetch(new URL(path, base), {
      headers: { 'x-forwarded-for': ip(viewer) },
    });
    await response.arrayBuffer();
    if (!response.ok)
      fail(
        `${path.split('?')[0].replace(/[1-9A-HJ-NP-Za-km-z]{32,44}/, ':mint')} ${response.status}`
      );
    stats.requests.push(performance.now() - began);
  } catch (error) {
    fail(
      `${path.split('?')[0].replace(/[1-9A-HJ-NP-Za-km-z]{32,44}/, ':mint')} ${error.cause?.code ?? error.name}`
    );
  }
}

/** Holds one SSE stream and records how long each pushed event took to arrive. */
async function stream(path, viewer, signal, onEvent) {
  try {
    const response = await fetch(new URL(path, base), {
      headers: { 'x-forwarded-for': ip(viewer), accept: 'text/event-stream' },
      signal,
    });
    if (!response.ok || !response.body) {
      stats.streamFailures++;
      fail(`stream ${response.status}`);
      return;
    }
    stats.streamsOpen++;
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = frame.split('\n').find((line) => line.startsWith('data: '));
        if (frame.includes('event: update') && data) onEvent(JSON.parse(data.slice(6)));
      }
    }
  } catch (error) {
    if (!signal.aborted) {
      stats.streamFailures++;
      fail(`stream dropped ${error.cause?.code ?? error.name}`);
    }
  } finally {
    stats.streamsOpen--;
  }
}

const db = new Client(databaseConfig());
await db.connect();
const coins = (await db.query('SELECT mint,coin FROM display_coins ORDER BY launched_at DESC'))
  .rows;
if (!coins.length) throw new Error('Index some coins first');
const sent = new Map();

const controller = new AbortController();
const started = performance.now();
const tasks = [];
const rampSeconds = Number(args['ramp-seconds'] ?? 20);
const arrive = (viewer) =>
  new Promise((resolve) => setTimeout(resolve, (viewer / viewers) * rampSeconds * 1000));
for (let viewer = 0; viewer < viewers; viewer++) {
  // A board visit: list, totals and rankings, then the live stream. Viewers arrive over the ramp.
  tasks.push(
    (async () => {
      await arrive(viewer);
      await Promise.all([
        get('/api/coins', viewer),
        get('/api/market-stats', viewer),
        get('/api/trending', viewer),
      ]);
      await stream('/api/live', viewer, controller.signal, (event) => {
        stats.events++;
        const at = sent.get(event.coin?.loadTestSeq);
        if (at) stats.lags.push(performance.now() - at);
        if (event.kind === 'board') void get('/api/coins', viewer);
      });
    })()
  );
  if (viewer < coinViewers) {
    const mint = coins[viewer % coins.length].mint;
    tasks.push(
      (async () => {
        await arrive(viewer * (viewers / Math.max(1, coinViewers)));
        await Promise.all([
          get(`/api/coins/${mint}`, viewer + viewers),
          get(`/api/coins/${mint}/trades`, viewer + viewers),
          get(`/api/coins/${mint}/holders`, viewer + viewers),
        ]);
        await stream(`/api/coins/${mint}/live`, viewer + viewers, controller.signal, (event) => {
          stats.events++;
          // Like the browser: coin and trade updates arrive in the event; only holders refetch.
          if (event.kind === 'holders' || event.kind === 'board')
            void get(`/api/coins/${mint}/holders`, viewer + viewers);
        });
      })()
    );
  }
}

// Simulated activity: each event changes one coin's market cap and announces it, like the indexer.
let seq = 0;
const ticker = setInterval(async () => {
  const { mint, coin } = coins[seq % coins.length];
  const loadTestSeq = ++seq;
  sent.set(loadTestSeq, performance.now());
  await db
    .query('UPDATE display_coins SET coin=$2::jsonb,updated_at=now() WHERE mint=$1', [
      mint,
      JSON.stringify({
        ...coin,
        loadTestSeq,
        marketCapSol: coin.marketCapSol + loadTestSeq / 1000,
      }),
    ])
    .then(() => db.query("SELECT pg_notify('display_index','coin:'||$1)", [mint]))
    .catch(() => fail('simulated update'));
}, 1000 / rate);

const report = setInterval(() => {
  console.log(
    JSON.stringify({
      t: Math.round((performance.now() - started) / 1000),
      streamsOpen: stats.streamsOpen,
      requests: stats.requests.length,
      events: stats.events,
      errors: stats.errors,
    })
  );
}, 10_000);
await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
clearInterval(ticker);
clearInterval(report);
const openAtEnd = stats.streamsOpen;
controller.abort();
await Promise.allSettled(tasks);
// Restore the coins the test touched.
for (const { mint, coin } of coins)
  await db.query('UPDATE display_coins SET coin=$2::jsonb WHERE mint=$1', [
    mint,
    JSON.stringify(coin),
  ]);
await db.end();
console.log(
  JSON.stringify(
    {
      viewers,
      coinViewers,
      seconds,
      simulatedUpdates: seq,
      streamsOpenAtEnd: openAtEnd,
      streamFailures: stats.streamFailures,
      requests: stats.requests.length,
      requestMs: {
        p50: Math.round(percentile(stats.requests, 0.5)),
        p95: Math.round(percentile(stats.requests, 0.95)),
        p99: Math.round(percentile(stats.requests, 0.99)),
      },
      eventsDelivered: stats.events,
      boardPushLagMs: {
        samples: stats.lags.length,
        p50: Math.round(percentile(stats.lags, 0.5) ?? -1),
        p95: Math.round(percentile(stats.lags, 0.95) ?? -1),
        p99: Math.round(percentile(stats.lags, 0.99) ?? -1),
      },
      errors: stats.errors,
    },
    null,
    2
  )
);
