const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateRollbackRequest } = require('./local-artifact-rollback.cjs');
const fixture = {
  purpose: 'rinsed-local-artifact-rollback',
  databaseUrl: 'postgres://rinsed_local:local-only@127.0.0.1:5432/rinsed_restore_20261028_022148',
  previousRoot: '/root/rinsed-rollback/previous',
  currentRoot: '/root/rinsed-rollback/current',
  previousArchiveSha256: 'a'.repeat(64),
  currentArchiveSha256: 'b'.repeat(64),
};
test('rollback requires distinct local artifacts and read-only restored database', () => {
  const safe = validateRollbackRequest(fixture, 'linux');
  assert.equal(
    new URL(safe.databaseUrl).searchParams.get('options'),
    '-c default_transaction_read_only=on'
  );
  assert.equal(safe.database, 'rinsed_restore_20261028_022148');
});
test('rollback refuses source/live databases, remote addresses, arbitrary paths and same version', () => {
  for (const databaseUrl of [
    'postgres://rinsed_local:x@127.0.0.1:5432/rinsed_local',
    'postgres://rinsed_local:x@db.example:5432/rinsed_restore_20261028_022148',
    fixture.databaseUrl.replace(':5432', ':55432'),
    fixture.databaseUrl + '?host=remote.example',
    fixture.databaseUrl + '?options=-c%20default_transaction_read_only=off',
  ])
    assert.throws(() => validateRollbackRequest({ ...fixture, databaseUrl }, 'linux'));
  for (const bad of [
    { previousRoot: '/root/web-build' },
    { currentRoot: '/root/rinsed-rollback/current/../previous' },
    { previousArchiveSha256: fixture.currentArchiveSha256 },
    { purpose: 'production' },
  ])
    assert.throws(() => validateRollbackRequest({ ...fixture, ...bad }, 'linux'));
  assert.throws(() => validateRollbackRequest(fixture, 'win32'));
});
