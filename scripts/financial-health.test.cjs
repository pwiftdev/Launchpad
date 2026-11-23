const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const path = require('node:path');
const appRequire = createRequire(path.resolve(__dirname, '../scaffolds/fun-launch/package.json'));
const { PublicKey, SystemProgram } = appRequire('@solana/web3.js');
const { collectFinancialHealth } = require('./financial-health.cjs');

function fixture({ balance = 1000, jobs = [], complete = true, rentBuffer = 1_000_000_000, missingAnchor = false, cursorSlot = '1000' } = {}) {
  const programId = PublicKey.unique(), mint = PublicKey.unique();
  const statements = [];
  const settings = Buffer.alloc(107); settings.write('RSET0001'); settings[8] = 1;
  const coin = Buffer.alloc(347); coin.write('RCOIN001'); coin[8] = 1; mint.toBuffer().copy(coin, 11); coin.writeBigUInt64LE(500n, 147);
  const [settingsAddress] = PublicKey.findProgramAddressSync([Buffer.from('settings')], programId);
  const rpc = {
    getGenesisHash: async () => 'isolated-genesis', getSlot: async () => 1000, getFirstAvailableBlock: async () => 0,
    getSignatureStatuses: async () => ({ value: [missingAnchor ? null : { err: null, confirmationStatus: 'finalized' }] }),
    getAccountInfo: async address => address.equals(programId) ? { executable: true } : address.equals(settingsAddress) ? { owner: programId, data: settings } : { owner: SystemProgram.programId, data: Buffer.alloc(0), lamports: rentBuffer },
    getMinimumBalanceForRentExemption: async () => 100,
    getMultipleAccountsInfo: async () => [{ owner: programId, data: coin, lamports: balance }],
  };
  const pool = { connect: async () => ({
    query: async (sql) => {
      statements.push(sql);
      assert.match(sql, /^(BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY|SET LOCAL|SELECT|ROLLBACK)/);
      if (sql.includes("'job' AS source")) return { rows: jobs };
      if (sql.includes('SELECT pool,complete')) return { rows: [{ pool: 'canonical-pool', complete, newest_signature: 'durable-cursor-anchor', finalized_slot: cursorSlot, age_seconds: '1' }] };
      if (sql.includes('SELECT bucket,sum')) return { rows: [{ bucket: 'rinse_buyback', available: '500' }] };
      if (sql.includes('FROM financial_funding_rounding')) return { rows: [{ raw_expected: '0', realized_net: '0', external_lp_excluded: '0', rounding_loss: '0' }] };
      if (sql.includes('FROM financial_damm_claim_windows')) return { rows: [{ windows: '0', raw_pool_fees: '0', realized_owned: '0', external_lp_excluded: '0', rounding_loss: '0' }] };
      if (sql.includes('FROM financial_zero_fee_events')) return { rows: [{ events: '0', raw_expected: '0' }] };
      if (sql.includes('AS funding_receipts')) return { rows: [{ coins: '1', fee_events: '1', funding_receipts: '1', funded_epochs: '0', prepared_epochs: '0', missing_index_cursors: '0' }] };
      if (sql.includes('SELECT mint,mode')) return { rows: [{ mint: mint.toBase58(), mode: 'creator' }] };
      return { rows: [] };
    }, release: () => statements.push('RELEASE'),
  }) };
  return { programId, pool, rpc, networkGenesis: 'isolated-genesis', statements };
}

test('health reads one read-only database snapshot and reports backed native budgets', async () => {
  const input = fixture();
  const result = await collectFinancialHealth(input);
  assert.equal(input.statements[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.deepEqual(input.statements.slice(-2), ['ROLLBACK', 'RELEASE']);
  assert.equal(result.ok, true);
  assert.equal(result.native[0].liabilities, '500');
  assert.equal(result.alerts.length, 0);
});

test('uncertain signed executions, manual review, stale indexing and missing native backing raise alerts', async () => {
  const result = await collectFinancialHealth(fixture({ balance: 599, complete: false, jobs: [
    { source: 'job', status: 'manual_review', count: '1', oldest_seconds: '1' },
    { source: 'operator_plan', status: 'submitted', count: '1', oldest_seconds: '200' },
  ] }));
  assert.equal(result.ok, false);
  assert.deepEqual(new Set(result.alerts.map(alert => alert.code)), new Set(['MANUAL_REVIEW', 'STALLED_SIGNED_EXECUTION', 'INDEX_REQUIRES_ATTENTION', 'NATIVE_LIABILITY_SHORTFALL']));
});

test('a mismatched RPC genesis prevents database access', async () => {
  const input = fixture(); input.networkGenesis = 'different-genesis';
  await assert.rejects(collectFinancialHealth(input), /Network mismatch/);
  assert.equal(input.statements.length, 0);
});

test('an empty protocol migration rent lender warns without reclassifying any vault budget', async () => {
  const result = await collectFinancialHealth(fixture({ rentBuffer: 0 }));
  assert(result.alerts.some(alert => alert.code === 'DBC_MIGRATION_RENT_BUFFER_LOW'));
  assert.equal(result.protocolMigrationRentBuffer.separateFromVaultBudgets, true);
  assert.equal(result.native[0].liabilities, '500');
});

test('pruned cursor evidence is critical even when its database cursor claims completeness', async () => {
  const result = await collectFinancialHealth(fixture({ missingAnchor: true }));
  assert.equal(result.ok, false);
  assert(result.alerts.some(alert => alert.code === 'INDEX_ANCHOR_UNAVAILABLE'));
});

test('an idle pool with a fresh complete scan is not mislabeled stalled by its old last transaction', async () => {
  const result = await collectFinancialHealth(fixture({ cursorSlot: '1' }));
  assert.equal(result.ok, true);
  assert.equal(result.cursors[0].poolTransactionLagSlots, 999);
  assert.equal(result.alerts.length, 0);
});
