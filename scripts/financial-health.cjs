/* Read-only operator monitoring. This module has no signer or transaction relay. */
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const workspace = path.resolve(__dirname, '..');
const appRequire = createRequire(path.join(workspace, 'scaffolds/fun-launch/package.json'));
const { Connection, PublicKey, SystemProgram } = appRequire('@solana/web3.js');
const { Pool } = appRequire('pg');
const { databaseConfig } = require('./postgres-config.cjs');
const { expectedNetworkGenesis } = require('./network-policy.cjs');
const layout = JSON.parse(fs.readFileSync(path.join(workspace, 'programs/rinsed-vault/state-layout.json'), 'utf8'));

async function collectFinancialHealth({ pool, rpc, networkGenesis, programId, maxCoins = 100 }) {
  if (!Number.isSafeInteger(maxCoins) || maxCoins < 1 || maxCoins > 1000) throw new Error('Invalid scan limit');
  if (await rpc.getGenesisHash() !== networkGenesis) throw new Error('Network mismatch');
  const finalizedSlot = await rpc.getSlot('finalized');
  const firstAvailableBlock = await rpc.getFirstAvailableBlock();
  const alerts = [];
  const client = await pool.connect();
  let report;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout = '10000ms'");
    const query = async sql => (await client.query(sql, [networkGenesis])).rows;
    const jobs = await query(`SELECT 'job' AS source,status,count(*)::text AS count,
      max(extract(epoch FROM now()-updated_at))::bigint::text AS oldest_seconds
      FROM financial_jobs WHERE network_genesis=$1 GROUP BY status
      UNION ALL SELECT 'operator_plan',status,count(*)::text,
      max(extract(epoch FROM now()-updated_at))::bigint::text
      FROM financial_operator_plans WHERE network_genesis=$1 GROUP BY status`);
    const cursors = await query(`SELECT pool,complete,newest_signature,finalized_slot::text,
      extract(epoch FROM now()-updated_at)::bigint::text AS age_seconds
      FROM financial_index_cursors WHERE network_genesis=$1 ORDER BY pool`);
    const balances = await query(`SELECT bucket,sum(accrued)::text AS accrued,sum(funded)::text AS funded,
      sum(reserved)::text AS reserved,sum(spent)::text AS spent,
      sum(funded-reserved-spent)::text AS available,sum(accrued-funded)::text AS unfunded_observed
      FROM financial_balances WHERE network_genesis=$1 GROUP BY bucket ORDER BY bucket`);
    const fundedRealization = (await query(`SELECT coalesce(sum(raw_expected),0)::text AS raw_expected,
      coalesce(sum(realized_net),0)::text AS realized_net,
      coalesce(sum(external_lp_excluded),0)::text AS external_lp_excluded,
      coalesce(sum(rounding_loss),0)::text AS rounding_loss
      FROM financial_funding_rounding WHERE network_genesis=$1`))[0];
    const finalizedClaimWindows = (await query(`SELECT count(*)::text AS windows,
      coalesce(sum(raw_pool_fees),0)::text AS raw_pool_fees,
      coalesce(sum(realized_owned),0)::text AS realized_owned,
      coalesce(sum(external_lp_excluded),0)::text AS external_lp_excluded,
      coalesce(sum(rounding_loss),0)::text AS rounding_loss
      FROM financial_damm_claim_windows WHERE network_genesis=$1 AND classification_policy='q128-growth-v1'`))[0];
    const zeroOwnedEvents = (await query(`SELECT count(*)::text AS events,
      coalesce(sum(raw_expected),0)::text AS raw_expected FROM financial_zero_fee_events WHERE network_genesis=$1`))[0];
    const counts = (await query(`SELECT
      (SELECT count(*)::text FROM launch_coins WHERE network_genesis=$1) AS coins,
      (SELECT count(*)::text FROM financial_funding WHERE network_genesis=$1) AS funding_receipts,
      (SELECT count(*)::text FROM financial_fee_events WHERE network_genesis=$1) AS fee_events,
      (SELECT count(*)::text FROM (SELECT dbc_pool AS pool FROM launch_coins WHERE network_genesis=$1 UNION SELECT damm_pool FROM launch_migrations WHERE network_genesis=$1) expected
        LEFT JOIN financial_index_cursors cursors ON cursors.network_genesis=$1 AND cursors.pool=expected.pool WHERE cursors.pool IS NULL) AS missing_index_cursors,
      (SELECT count(*)::text FROM financial_epochs WHERE network_genesis=$1 AND status='funded') AS funded_epochs,
      (SELECT count(*)::text FROM financial_epochs WHERE network_genesis=$1 AND status='prepared') AS prepared_epochs`))[0];
    const coins = (await client.query(`SELECT mint,mode FROM launch_coins WHERE network_genesis=$1 ORDER BY mint LIMIT $2`, [networkGenesis, maxCoins])).rows;
    report = { checkedAt: new Date().toISOString(), networkGenesis, finalizedSlot, firstAvailableBlock, readOnly: true, counts, jobs, cursors, balances, fundedRealization, finalizedClaimWindows, zeroOwnedEvents, coins };
  } finally {
    try { await client.query('ROLLBACK'); } finally { client.release(); }
  }
  for (const row of report.jobs) {
    if (row.status === 'manual_review') alerts.push({ severity: 'critical', code: 'MANUAL_REVIEW', source: row.source, count: row.count });
    if (['signed', 'submitted'].includes(row.status) && Number(row.oldest_seconds) > 180)
      alerts.push({ severity: 'critical', code: 'STALLED_SIGNED_EXECUTION', source: row.source, status: row.status, count: row.count });
    if (row.status === 'prepared' && Number(row.oldest_seconds) > 900)
      alerts.push({ severity: 'warning', code: 'STALE_PREPARED_EXECUTION', source: row.source, count: row.count });
  }
  for (const cursor of report.cursors) {
    cursor.poolTransactionLagSlots = Math.max(0, finalizedSlot - Number(cursor.finalized_slot));
    // finalized_slot is the newest pool transaction, so a large slot gap alone can mean an idle pool.
    if (!cursor.complete || Number(cursor.age_seconds) > 180)
      alerts.push({ severity: 'warning', code: 'INDEX_REQUIRES_ATTENTION', pool: cursor.pool, complete: cursor.complete, poolTransactionLagSlots: cursor.poolTransactionLagSlots, ageSeconds: cursor.age_seconds });
  }
  if (BigInt(report.counts.missing_index_cursors) > 0n) alerts.push({ severity: 'warning', code: 'MISSING_INDEX_CURSORS', count: report.counts.missing_index_cursors });
  const anchoredCursors = report.cursors.filter(cursor => cursor.newest_signature);
  for (let start = 0; start < anchoredCursors.length; start += 256) {
    const batch = anchoredCursors.slice(start, start + 256);
    const statuses = await rpc.getSignatureStatuses(batch.map(cursor => cursor.newest_signature), { searchTransactionHistory: true });
    batch.forEach((cursor, index) => {
      if (!statuses.value[index] || statuses.value[index].err)
        alerts.push({ severity: 'critical', code: 'INDEX_ANCHOR_UNAVAILABLE', pool: cursor.pool, signature: cursor.newest_signature });
    });
  }
  const program = await rpc.getAccountInfo(programId, 'finalized');
  if (!program?.executable) alerts.push({ severity: 'critical', code: 'VAULT_PROGRAM_UNAVAILABLE' });
  const [settings] = PublicKey.findProgramAddressSync([Buffer.from('settings')], programId);
  const settingsAccount = await rpc.getAccountInfo(settings, 'finalized');
  if (!settingsAccount?.owner.equals(programId) || settingsAccount.data.length !== layout.settings.size ||
      settingsAccount.data.subarray(0, 8).toString('ascii') !== layout.settings.magic || settingsAccount.data[8] !== 1 || settingsAccount.data[10] > 1)
    alerts.push({ severity: 'critical', code: 'VAULT_SETTINGS_UNAVAILABLE' });
  else report.vaultPaused = settingsAccount.data[10] === 1;
  if (report.vaultPaused) alerts.push({ severity: 'warning', code: 'FUTURE_VAULT_WORK_PAUSED' });
  const dbcProgram = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN');
  const [dbcRentAddress] = PublicKey.findProgramAddressSync([Buffer.from('pool_authority')], dbcProgram);
  const dbcRent = await rpc.getAccountInfo(dbcRentAddress, 'finalized');
  const validRentBuffer = !!dbcRent && dbcRent.owner.equals(SystemProgram.programId) && dbcRent.data.length === 0;
  report.protocolMigrationRentBuffer = { address: dbcRentAddress.toBase58(), recommendedLamports: '1000000000',
    balanceLamports: validRentBuffer && Number.isSafeInteger(dbcRent.lamports) ? String(dbcRent.lamports) : null,
    separateFromVaultBudgets: true };
  if (!validRentBuffer || dbcRent.lamports < 1_000_000_000) alerts.push({ severity: 'warning', code: 'DBC_MIGRATION_RENT_BUFFER_LOW' });
  const rent = BigInt(await rpc.getMinimumBalanceForRentExemption(layout.coin.size, 'finalized'));
  const native = [];
  for (let start = 0; start < report.coins.length; start += 100) {
    const batch = report.coins.slice(start, start + 100);
    const addresses = batch.map(coin => PublicKey.findProgramAddressSync([Buffer.from('coin'), new PublicKey(coin.mint).toBuffer()], programId)[0]);
    const accounts = await rpc.getMultipleAccountsInfo(addresses, 'finalized');
    for (let index = 0; index < batch.length; index++) {
      const coin = batch[index], account = accounts[index];
      if (!account?.owner.equals(programId) || account.data.length !== layout.coin.size || account.data.subarray(0, 8).toString('ascii') !== layout.coin.magic || account.data[8] !== 1 ||
          !new PublicKey(account.data.subarray(layout.coin.fields.mint, layout.coin.fields.mint + 32)).equals(new PublicKey(coin.mint))) {
        alerts.push({ severity: 'critical', code: 'NATIVE_COIN_UNAVAILABLE', mint: coin.mint });
        continue;
      }
      const budgetFields = ['buyback', 'creatorBudget', 'community', 'platform', 'unallocatedCollected'];
      const budgets = Object.fromEntries(budgetFields.map(field => [field, account.data.readBigUInt64LE(layout.coin.fields[field]).toString()]));
      const liability = Object.values(budgets).reduce((sum, value) => sum + BigInt(value), 0n);
      const safeBalance = Number.isSafeInteger(account.lamports);
      if (!safeBalance || BigInt(account.lamports) < liability + rent)
        alerts.push({ severity: 'critical', code: safeBalance ? 'NATIVE_LIABILITY_SHORTFALL' : 'NATIVE_BALANCE_PRECISION_UNAVAILABLE', mint: coin.mint });
      native.push({ mint: coin.mint, budgets, liabilities: liability.toString(), rentFloor: rent.toString(), balanceLamports: safeBalance ? String(account.lamports) : null });
    }
  }
  if (BigInt(report.counts.coins) > BigInt(report.coins.length)) alerts.push({ severity: 'warning', code: 'NATIVE_SCAN_TRUNCATED', scanned: report.coins.length, total: report.counts.coins });
  delete report.coins;
  return { ...report, native, alerts, ok: !alerts.some(alert => alert.severity === 'critical'), nativeCoverage: 'Registered coin budgets only; epoch accounts require their separate finalized claim/funding verifiers.', note: 'Unfunded observed accrual is not payable. Funded-plan exclusion/rounding labels can be provisional; finalizedClaimWindows contains definitive closed-window categories. Database and finalized RPC reads are separate observations. No funds were moved.' };
}

async function main() {
  if (process.argv.length !== 2) throw new Error('No command arguments accepted; configure private operator environment');
  if (!process.env.RPC_URL || !process.env.VAULT_PROGRAM_ID) throw new Error('Monitoring configuration unavailable');
  const networkGenesis = expectedNetworkGenesis();
  const pool = new Pool({ ...databaseConfig(), application_name: 'rinsed-financial-health' });
  pool.on('error', () => {});
  try {
    const rpc = new Connection(process.env.RPC_URL, { commitment: 'finalized', disableRetryOnRateLimit: true,
      fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(10000) }) });
    const result = await collectFinancialHealth({ pool, rpc, networkGenesis, programId: new PublicKey(process.env.VAULT_PROGRAM_ID), maxCoins: Number(process.env.FINANCIAL_HEALTH_MAX_COINS || 100) });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 2;
  } finally { await pool.end(); }
}

module.exports = { collectFinancialHealth };
if (require.main === module) main().catch(() => {
  console.error(JSON.stringify({ ok: false, code: 'FINANCIAL_HEALTH_CHECK_FAILED', note: 'Check private TLS/database/RPC settings and pinned genesis. Configuration and provider errors are withheld.' }));
  process.exitCode = 1;
});
