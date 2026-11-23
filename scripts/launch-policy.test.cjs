const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inspectLaunchConfig } = require('./launch-policy.cjs');

const authorities = { feeClaimer: 'reviewed-vault', leftoverReceiver: 'reviewed-receiver' };
const config = () => ({
  poolFees: {
    baseFee: {
      cliffFeeNumerator: 900000000n,
      baseFeeMode: 1,
      firstFactor: 9,
      secondFactor: 3n,
      thirdFactor: 3782n,
    },
    dynamicFee: { initialized: 0 },
  },
  collectFeeMode: 0,
  activationType: 1,
  quoteMint: 'So11111111111111111111111111111111111111112',
  tokenDecimal: 6,
  tokenType: 0,
  tokenUpdateAuthority: 1,
  preMigrationTokenSupply: 1000000000000000n,
  postMigrationTokenSupply: 1000000000000000n,
  migrationQuoteThreshold: 80000000000n,
  migrationOption: 1,
  migrationFeeOption: 6,
  migratedCollectFeeMode: 0,
  migratedDynamicFee: 0,
  migratedPoolFeeBps: 125,
  migratedPoolBaseFeeMode: 0,
  creatorTradingFeePercentage: 0,
  partnerPermanentLockedLiquidityPercentage: 100,
  partnerLiquidityPercentage: 0,
  creatorPermanentLockedLiquidityPercentage: 0,
  creatorLiquidityPercentage: 0,
  poolCreationFee: 0n,
  migrationFeePercentage: 0,
  creatorMigrationFeePercentage: 0,
  ...authorities,
});

test('accepts the planned schedule and independently supplied authorities', () => {
  assert.deepEqual(inspectLaunchConfig(config(), authorities), []);
});
test('rejects wrong starting tax, dynamic fees and the legacy migration fee', () => {
  const legacy = config();
  legacy.poolFees.baseFee.cliffFeeNumerator = 700000000n;
  legacy.poolFees.dynamicFee.initialized = 1;
  legacy.migrationFeeOption = 2;
  legacy.migratedPoolFeeBps = 100;
  assert.deepEqual(
    inspectLaunchConfig(legacy, authorities).map((x) => x.field),
    ['startingFeeNumerator', 'dynamicFeeEnabled', 'migrationFeeOption', 'migratedPoolFeeBps']
  );
});
test('does not trust an observed fee claimer as proof of its intended owner', () => {
  assert.deepEqual(
    inspectLaunchConfig(config()).map((x) => x.field),
    ['feeClaimer', 'leftoverReceiver']
  );
  assert.deepEqual(
    inspectLaunchConfig(config(), { ...authorities, feeClaimer: 'unexpected-wallet' }).map(
      (x) => x.field
    ),
    ['feeClaimer']
  );
});
test('fails closed when configuration fields are missing', () => {
  const incomplete = config();
  delete incomplete.preMigrationTokenSupply;
  delete incomplete.poolFees.baseFee.thirdFactor;
  delete incomplete.poolFees.dynamicFee;
  assert.deepEqual(
    inspectLaunchConfig(incomplete, authorities).map((x) => x.field),
    ['reductionBps', 'dynamicFee', 'preMigrationTokenSupply']
  );
});
test('rejects a parallel creator LP fee path and additional creation/migration charges', () => {
  const bypass = config();
  bypass.partnerPermanentLockedLiquidityPercentage = 50;
  bypass.creatorPermanentLockedLiquidityPercentage = 50;
  bypass.poolCreationFee = 20_000_000n;
  bypass.migrationFeePercentage = 2;
  assert.deepEqual(
    inspectLaunchConfig(bypass, authorities).map((issue) => issue.field),
    [
      'partnerPermanentLockedLiquidityPercentage',
      'creatorPermanentLockedLiquidityPercentage',
      'poolCreationFee',
      'migrationFeePercentage',
    ]
  );
});
test('wallet-v1 accepts pinned ordinary wallets and refuses native PDA collectors without changing the schedule', () => {
  const { createRequire } = require('node:module'),
    app = createRequire(
      require('node:path').resolve(__dirname, '../scaffolds/fun-launch/package.json')
    ),
    { Keypair, PublicKey } = app('@solana/web3.js');
  const expected = {
    feeClaimer: Keypair.generate().publicKey.toBase58(),
    leftoverReceiver: Keypair.generate().publicKey.toBase58(),
    policyVersion: 'wallet-v1',
  };
  assert.deepEqual(
    inspectLaunchConfig(
      { ...config(), feeClaimer: expected.feeClaimer, leftoverReceiver: expected.leftoverReceiver },
      expected
    ),
    []
  );
  const pda = PublicKey.findProgramAddressSync(
    [Buffer.from('fee-authority')],
    Keypair.generate().publicKey
  )[0].toBase58();
  assert(
    inspectLaunchConfig(
      { ...config(), feeClaimer: pda, leftoverReceiver: expected.leftoverReceiver },
      { ...expected, feeClaimer: pda }
    ).some((issue) => issue.field === 'feeClaimerWallet')
  );
});
