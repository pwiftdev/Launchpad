import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function runMigration(settings = {}) {
  const folder = mkdtempSync(path.join(tmpdir(), 'rinsed-migration-test-'));
  const trace = path.join(folder, 'trace.json');
  const preload = path.join(folder, 'pg-fixture.cjs');
  const ca = path.join(folder, 'fixture-ca.pem');
  writeFileSync(ca, 'isolated mock certificate; no network connection is made');
  writeFileSync(
    preload,
    `
    const Module=require('node:module'),fs=require('node:fs'),original=Module._load,events=[];
    const record=value=>{events.push(value);fs.writeFileSync(process.env.TEST_MIGRATION_TRACE,JSON.stringify(events));};
    Module._load=function(name,...args){
      if(name!=='pg')return original.call(this,name,...args);
      return{Pool:class{
        constructor(config){if(config.ssl.rejectUnauthorized!==true)throw new Error('TLS disabled');record('pool');}
        async connect(){return{query:async sql=>{
          record(sql.trim().split(/\\s+/).slice(0,3).join(' '));
          if(process.env.TEST_MIGRATION_FAILURE==='true'&&sql.includes('CREATE TABLE'))throw new Error('private-provider-detail');
          return{rows:[]};
        },release(){record('release');}};}
        async end(){record('end');}
      }};
    };
  `
  );
  try {
    const result = spawnSync(process.execPath, ['--require', preload, 'scripts/migrate.mjs'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DATABASE_URL: '',
        DATABASE_SSL_CA: ca,
        WHITELIST_ENABLED: 'false',
        FINANCIAL_WORKER_ENABLED: 'false',
        LAUNCH_POLICY_VERSION: '',
        VAULT_PROGRAM_ID: '',
        TEST_MIGRATION_TRACE: trace,
        TEST_MIGRATION_FAILURE: 'false',
        ...settings,
      },
    });
    let events = [];
    try {
      events = JSON.parse(readFileSync(trace, 'utf8'));
    } catch {
      /* No pool was created. */
    }
    return { ...result, events };
  } finally {
    if (
      path.dirname(folder) !== path.resolve(tmpdir()) ||
      !path.basename(folder).startsWith('rinsed-migration-test-')
    )
      throw new Error('Unsafe temporary migration test directory');
    rmSync(folder, { recursive: true, force: true });
  }
}

test('skips migrations only when no database feature or configured database exists', () => {
  const result = runMigration();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.events, []);
  assert.match(result.stdout, /no migration needed/);
});
test('migrates configured financial storage with whitelist registration disabled', () => {
  const result = runMigration({
    DATABASE_URL: 'postgres://fixture:private-password@127.0.0.1:1/isolated',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.events.includes('BEGIN'));
  assert.ok(result.events.includes('COMMIT'));
  assert.equal(result.events.at(-1), 'end');
  assert.match(result.stdout, /Application database schema ready/);
  assert.doesNotMatch(result.stdout + result.stderr, /private-password/);
});
test('fails closed without storage for enabled registration or financial features', () => {
  for (const settings of [
    { WHITELIST_ENABLED: 'true' },
    { FINANCIAL_WORKER_ENABLED: 'true' },
    { LAUNCH_POLICY_VERSION: 'rinse-v1' },
    { VAULT_PROGRAM_ID: 'fixture-program' },
  ]) {
    const result = runMigration(settings);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Database migration failed/);
    assert.doesNotMatch(result.stderr, /Error:|at databaseConfig/);
  }
});
test('rolls back a failed migration and never logs connection/provider details', () => {
  const result = runMigration({
    DATABASE_URL: 'postgres://fixture:private-password@127.0.0.1:1/isolated',
    TEST_MIGRATION_FAILURE: 'true',
  });
  assert.equal(result.status, 1);
  assert.ok(result.events.includes('ROLLBACK'));
  assert.ok(!result.events.includes('COMMIT'));
  assert.equal(result.events.at(-1), 'end');
  assert.doesNotMatch(result.stdout + result.stderr, /private-password|private-provider-detail/);
  const malformed = runMigration({ DATABASE_URL: 'invalid-private-connection-value' });
  assert.equal(malformed.status, 1);
  assert.doesNotMatch(malformed.stderr, /invalid-private-connection-value/);
});
