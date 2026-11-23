/* Isolated Linux acceptance only. No deployment, migration, wallet, or relay capability. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const net = require('node:net');
const { createRequire } = require('node:module');
const app = createRequire(path.resolve(__dirname, '../scaffolds/fun-launch/package.json'));
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
let rollbackStage = 'request-validation';

function validateRollbackRequest(input, platform = process.platform) {
  if (platform !== 'linux' || input?.purpose !== 'rinsed-local-artifact-rollback')
    throw new Error('Only the isolated Linux rollback fixture is permitted');
  const url = new URL(input.databaseUrl);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.hostname !== '127.0.0.1' ||
    url.port !== '5432' ||
    !/^\/rinsed_restore_[0-9]{8}_[0-9]{6}$/.test(url.pathname) ||
    decodeURIComponent(url.username) !== 'rinsed_local' ||
    !url.password ||
    [...url.searchParams.keys()].some((key) => key !== 'sslmode')
  )
    throw new Error('Rollback requires a newly restored isolated database');
  if (
    input.previousRoot !== '/root/rinsed-rollback/previous' ||
    input.currentRoot !== '/root/rinsed-rollback/current' ||
    !/^[a-f0-9]{64}$/.test(input.previousArchiveSha256 ?? '') ||
    !/^[a-f0-9]{64}$/.test(input.currentArchiveSha256 ?? '') ||
    input.previousArchiveSha256 === input.currentArchiveSha256
  )
    throw new Error('Distinct pinned isolated artifacts are required');
  // Node-postgres passes this option to PostgreSQL, including in spawned web processes.
  url.search = '';
  url.searchParams.set('options', '-c default_transaction_read_only=on');
  return { ...input, databaseUrl: url.href, database: url.pathname.slice(1) };
}

async function databaseSnapshot(pool) {
  const client = await pool.connect();
  try {
    rollbackStage = 'database-read-only';
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    if ((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only !== 'on')
      throw new Error('Read-only snapshot required');
    const schema = (
      await client.query(`
      SELECT 'column' AS kind,table_name AS object,ordinal_position::text AS item,to_jsonb(c)::text AS definition
      FROM information_schema.columns c WHERE table_schema='public'
      UNION ALL SELECT 'constraint',r.relname,c.conname,pg_get_constraintdef(c.oid)
      FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace WHERE n.nspname='public'
      UNION ALL SELECT 'index',tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public'
      UNION ALL SELECT 'trigger',r.relname,t.tgname,pg_get_triggerdef(t.oid)
      FROM pg_trigger t JOIN pg_class r ON r.oid=t.tgrelid JOIN pg_namespace n ON n.oid=r.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal
      UNION ALL SELECT 'function',p.proname,p.oid::regprocedure::text,pg_get_functiondef(p.oid)
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f'
      ORDER BY kind,object,item,definition
    `)
    ).rows;
    const tables = {};
    for (const { tablename } of (
      await client.query(
        "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"
      )
    ).rows) {
      if (!/^[a-z_][a-z0-9_]*$/.test(tablename))
        throw new Error('Unexpected fixture table identifier');
      const rows = (
        await client.query(
          `SELECT to_jsonb(t)::text AS value FROM public."${tablename}" t ORDER BY 1 LIMIT 50001`
        )
      ).rows;
      const body = JSON.stringify(rows);
      if (rows.length > 50000 || Buffer.byteLength(body) > 32 * 1024 * 1024)
        throw new Error('Local rollback fixture exceeds inventory capacity');
      tables[tablename] = { rows: rows.length, sha256: sha(body) };
    }
    await client.query('ROLLBACK');
    return {
      schemaSha256: sha(JSON.stringify(schema)),
      tables,
      dataSha256: sha(JSON.stringify(tables)),
    };
  } finally {
    client.release();
  }
}

async function runRollbackDrill(input) {
  const request = validateRollbackRequest(input);
  const { Pool } = app('pg');
  const ca = fs.readFileSync('/var/lib/postgresql/rinsed-server.crt', 'utf8');
  const pool = new Pool({
    connectionString: request.databaseUrl,
    ssl: { rejectUnauthorized: true, ca },
    max: 1,
  });
  const origin = 'http://127.0.0.1:3117';
  const configuredPublicOrigin = 'https://launch.example';
  const privateWhitelistSecret = crypto.randomBytes(32).toString('hex');
  try {
    if (
      (await pool.query('SHOW default_transaction_read_only')).rows[0]
        .default_transaction_read_only !== 'on'
    )
      throw new Error('Read-only database connection option was not enforced');
    rollbackStage = 'database-inventory-before';
    const before = await databaseSnapshot(pool);
    const expectedCount = Number(
      (await pool.query('SELECT count(*)::int AS count FROM whitelist_entries')).rows[0].count
    );
    const results = [];
    for (const [version, root, archiveSha256] of [
      ['current', request.currentRoot, request.currentArchiveSha256],
      ['previous-test-only', request.previousRoot, request.previousArchiveSha256],
      ['current', request.currentRoot, request.currentArchiveSha256],
    ]) {
      const project = path.join(root, 'scaffolds/fun-launch');
      rollbackStage = version + '-startup';
      const buildId = fs.readFileSync(path.join(project, '.next/BUILD_ID'), 'utf8').trim();
      await new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', () => reject(new Error('Isolated rollback port is already occupied')));
        probe.listen(3117, '127.0.0.1', () => probe.close(resolve));
      });
      const child = spawn(process.execPath, [path.join(project, 'server.js')], {
        cwd: project,
        env: {
          ...process.env,
          NODE_ENV: 'production',
          HOSTNAME: '127.0.0.1',
          PORT: '3117',
          DATABASE_URL: request.databaseUrl,
          DATABASE_SSL_CA: '/var/lib/postgresql/rinsed-server.crt',
          WHITELIST_ENABLED: 'true',
          WHITELIST_SECRET: privateWhitelistSecret,
          ADMIN_KEY_HASH: '',
          ADMIN_SESSION_SECRET: '',
          FINANCIAL_WORKER_ENABLED: 'false',
          TRADING_ENABLED: 'false',
          MAINNET_TRADING_ENABLED: 'false',
          LOCAL_VALIDATOR_ENABLED: 'false',
          NEXT_PUBLIC_SITE_URL: configuredPublicOrigin,
          SITE_ALLOWED_ORIGINS: configuredPublicOrigin,
          RPC_URL: 'http://127.0.0.1:8899',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let startupFailed = false;
      child.on('error', () => {
        startupFailed = true;
      });
      // Never return raw server/provider errors or environment configuration.
      child.stdout.resume();
      child.stderr.resume();
      try {
        let ready = false;
        for (let attempt = 0; attempt < 80; attempt++) {
          if (startupFailed || child.exitCode !== null || child.signalCode !== null)
            throw new Error('Isolated candidate exited during startup');
          if ((await fetch(origin + '/api/health').catch(() => null))?.ok) {
            ready = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (!ready) throw new Error('Isolated candidate did not become ready');
        rollbackStage = version + '-build-identity';
        if (!(await fetch(origin + '/_next/static/' + buildId + '/_buildManifest.js')).ok)
          throw new Error('Running artifact build identity differs');
        rollbackStage = version + '-whitelist-page';
        if (!(await fetch(origin + '/whitelist')).ok) throw new Error('Whitelist page failed');
        rollbackStage = version + '-database-api-read';
        const stats = await fetch(origin + '/api/whitelist');
        const body = await stats.json();
        if (stats.status !== 200 || body.count !== expectedCount || body.registration !== null)
          throw new Error('Candidate cannot read the restored current whitelist schema');
        rollbackStage = version + '-private-gate';
        const launch = await fetch(origin + '/launch', { redirect: 'manual' });
        if (launch.status !== 307 || !launch.headers.get('location')?.endsWith('/whitelist'))
          throw new Error('Public gate opened during rollback');
        const upload = await fetch(origin + '/api/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: 'null',
        });
        if (upload.status !== 401) throw new Error('Unauthorized mutation was not rejected');
        let monitoring;
        if (version === 'current') {
          rollbackStage = 'current-read-only-monitoring';
          const { collectWebHealth, collectDatabaseHealth } = require('./web-health.cjs');
          const redirect = await fetch(origin + '/', {
            redirect: 'manual',
            headers: { host: new URL(configuredPublicOrigin).host },
          });
          const advertisedOrigin = new URL(redirect.headers.get('location'), origin).origin;
          if (advertisedOrigin !== configuredPublicOrigin)
            throw new Error(
              'Artifact redirect differs from its explicitly configured public origin'
            );
          const web = await collectWebHealth({
            origin: configuredPublicOrigin,
            allowLocal: true,
            registrationExpected: true,
            slowMs: 1500,
            fetchImpl: (url, options) => {
              const target = new URL(url);
              if (target.origin !== configuredPublicOrigin)
                throw new Error('Monitor left the pinned artifact origin');
              const headers = new Headers(options.headers);
              headers.set('host', new URL(configuredPublicOrigin).host);
              // Physical transport stays loopback; Host and expected redirect remain canonical.
              return fetch(origin + target.pathname + target.search, { ...options, headers });
            },
          });
          const database = await collectDatabaseHealth({ pool, slowMs: 1000 });
          if (!web.ok || !database.ok) {
            console.error(JSON.stringify({ stage: 'current-read-only-monitoring', web, database }));
            const document = await fetch(origin + '/whitelist');
            const html = await document.text();
            console.error(
              JSON.stringify({
                publicDocumentDiagnostic: {
                  policy: document.headers.get('content-security-policy'),
                  contentType: document.headers.get('content-type'),
                  title: html.match(/<title\b[^>]*>[\s\S]*?<\/title>/i)?.[0] ?? null,
                  nosniff: document.headers.get('x-content-type-options'),
                  frame: document.headers.get('x-frame-options'),
                },
              })
            );
            throw new Error('Current rollback candidate failed live read-only monitoring');
          }
          monitoring = {
            physicalProbeOrigin: origin,
            advertisedCanonicalOrigin: advertisedOrigin,
            web,
            database,
          };
        }
        results.push({
          version,
          archiveSha256,
          buildId,
          port: 3117,
          databaseReadPassed: true,
          publicGateClosed: true,
          unauthorizedMutationRejected: true,
          ...(monitoring ? { monitoring } : {}),
        });
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM');
          await Promise.race([
            new Promise((resolve) => child.once('exit', resolve)),
            new Promise((resolve) => setTimeout(resolve, 5000)),
          ]);
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
            throw new Error('Isolated candidate failed graceful shutdown');
          }
        }
      }
    }
    if (results[0].buildId === results[1].buildId || results[0].buildId !== results[2].buildId)
      throw new Error('Rollback did not switch distinct builds and restore the current build');
    rollbackStage = 'database-inventory-after';
    const after = await databaseSnapshot(pool);
    if (JSON.stringify(before) !== JSON.stringify(after))
      throw new Error('Restored database changed during rollback');
    return {
      purpose: request.purpose,
      database: request.database,
      sequence: results,
      schemaSha256: before.schemaSha256,
      dataSha256: before.dataSha256,
      tablesVerified: Object.keys(before.tables).length,
      databaseUnchanged: true,
      readOnlyDatabaseConnection: true,
      previousBuildIsTestOnly: true,
      productionFallbackApproved: false,
      hostingChanged: false,
      chainTransactionsSent: false,
    };
  } finally {
    await pool.end();
  }
}
module.exports = { validateRollbackRequest, databaseSnapshot, runRollbackDrill };
if (require.main === module)
  (async () => {
    let raw = '';
    for await (const chunk of process.stdin) {
      raw += chunk;
      if (raw.length > 8192) throw new Error('Oversized fixture request');
    }
    console.log(JSON.stringify(await runRollbackDrill(JSON.parse(raw))));
  })().catch((error) => {
    console.error(
      JSON.stringify({
        error: 'LOCAL_ROLLBACK_FAILED',
        stage: rollbackStage,
        ...(typeof error.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.code)
          ? { code: error.code }
          : {}),
      })
    );
    process.exitCode = 1;
  });
