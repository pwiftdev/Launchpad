import { test } from 'node:test';
import assert from 'node:assert/strict';
import { artifactIdentity } from './audit-upload-artifacts.mjs';
const key = 'So11111111111111111111111111111111111111112';
const now = Date.parse('2026-10-28T12:00:00Z');
const file = {
  created_at: '2026-10-26T12:00:00Z',
  keyvalues: {
    rinsed_app: 'launchpad-v1',
    rinsed_mint: key,
    rinsed_config: key,
    rinsed_genesis: key,
    rinsed_purpose: 'image',
  },
};
test('only classifies tagged, expired, matching-chain artifacts', () => {
  assert.equal(artifactIdentity(file, key, now).status, 'check_chain');
  assert.equal(artifactIdentity({ ...file, keyvalues: {} }, key, now), null);
  assert.equal(
    artifactIdentity({ ...file, created_at: '2026-10-28T11:00:00Z' }, key, now).status,
    'retention_window'
  );
  assert.equal(artifactIdentity(file, 'different', now).status, 'different_chain');
});
test('invalid timestamps and identities can never become cleanup candidates', () => {
  assert.equal(
    artifactIdentity({ ...file, created_at: 'not a date' }, key, now).status,
    'invalid_timestamp'
  );
  assert.equal(
    artifactIdentity({ ...file, keyvalues: { ...file.keyvalues, rinsed_mint: '../bad' } }, key, now)
      .status,
    'invalid_identity'
  );
});
