const { test } = require('node:test'),
  assert = require('node:assert/strict');
const { Keypair, PublicKey } = require('@solana/web3.js');
const { buildWalletLaunchTemplate } = require('./wallet-launch-template.cjs');
const sdk = require('@meteora-ag/dynamic-bonding-curve-sdk');
const BN = require('bn.js');
test('canonical SDK wallet config preserves reviewed schedule, supply and locked LP policy while explicitly replacing old recipients', () => {
  const collector = Keypair.generate().publicKey,
    treasury = Keypair.generate().publicKey,
    config = buildWalletLaunchTemplate({ collector, treasury, policyVersion: 'wallet-v1' });
  assert(config.feeClaimer.equals(collector));
  assert(config.leftoverReceiver.equals(treasury));
  assert.equal(config.poolFees.baseFee.cliffFeeNumerator.toString(), '900000000');
  assert.equal(config.tokenSupply.preMigrationTokenSupply.toString(), '1000000000000000');
  assert.equal(config.migratedPoolFee.poolFeeBps, 125);
  assert.equal(config.partnerPermanentLockedLiquidityPercentage, 100);
  assert.equal(config.poolCreationFee.toString(), '0');
});

test('Bond it. protects only slot zero, exempts the bundled first buy and graduates at exactly 1%', () => {
  const config = buildWalletLaunchTemplate({
    collector: Keypair.generate().publicKey,
    treasury: Keypair.generate().publicKey,
  });
  const base = config.poolFees.baseFee;
  assert.equal(config.activationType, 0);
  assert.equal(config.enableFirstSwapWithMinFee, true);
  assert.equal(config.migratedPoolFee.poolFeeBps, 100);
  for (const [slot, expected] of [
    [500, '990000000'],
    [501, '12500000'],
    [999, '12500000'],
  ]) {
    assert.equal(
      sdk
        .getBaseFeeNumerator(
          base.cliffFeeNumerator,
          base.firstFactor,
          base.secondFactor,
          base.thirdFactor,
          base.baseFeeMode,
          new BN(slot),
          new BN(500)
        )
        .toString(),
      expected
    );
  }
  assert.equal(
    sdk
      .getFeeSchedulerMinBaseFeeNumerator(
        base.cliffFeeNumerator,
        base.firstFactor,
        base.thirdFactor,
        base.baseFeeMode
      )
      .toString(),
    '12500000'
  );
  assert.equal(config.poolFees.dynamicFee, null);
  assert.equal(config.partnerPermanentLockedLiquidityPercentage, 100);
});
test('canonical generator refuses native PDA and default recipients before preparing any transaction', () => {
  const treasury = Keypair.generate().publicKey,
    pda = PublicKey.findProgramAddressSync(
      [Buffer.from('fee-authority')],
      Keypair.generate().publicKey
    )[0];
  assert.throws(() => buildWalletLaunchTemplate({ collector: pda, treasury }), /ordinary/);
  assert.throws(
    () => buildWalletLaunchTemplate({ collector: PublicKey.default, treasury }),
    /ordinary/
  );
});

test('MSKD modes: one-slot 99% guard, then a flat 1.25% before and after bonding', () => {
  const wallets = { collector: Keypair.generate().publicKey, treasury: Keypair.generate().publicKey };
  for (const policyVersion of ['dev-v1', 'cashback-v1']) {
    const config = buildWalletLaunchTemplate({ ...wallets, policyVersion });
    assert.equal(config.activationType, 0);
    assert.equal(config.enableFirstSwapWithMinFee, true);
    assert.equal(config.poolFees.baseFee.cliffFeeNumerator.toString(), '990000000');
    assert.equal(config.migratedPoolFee.poolFeeBps, 125);
    assert.equal(config.migrationFeeOption, 6);
    assert.equal(config.quoteMint.toBase58(), 'So11111111111111111111111111111111111111112');
    assert.equal(config.migrationQuoteThreshold.toString(), '80000000000');
    assert.equal(config.creatorTradingFeePercentage, 0);
    assert.equal(config.partnerPermanentLockedLiquidityPercentage, 100);
  }
});

test('MSKD mode pairs to a pinned hSOL mint with a reviewed 9-decimal bonding target', () => {
  const wallets = { collector: Keypair.generate().publicKey, treasury: Keypair.generate().publicKey };
  const quoteMint = 'he1iusmfkpAdwvxLNGV8Y1iSbj4rUy6yMhEA3fotn9A';
  const config = buildWalletLaunchTemplate({
    ...wallets,
    policyVersion: 'mskd-v1',
    quoteMint,
    migrationQuoteThreshold: '68',
  });
  assert.equal(config.quoteMint.toBase58(), quoteMint);
  assert.equal(config.migrationQuoteThreshold.toString(), '68000000000');
  assert.equal(config.migratedPoolFee.poolFeeBps, 125);
  assert.throws(
    () => buildWalletLaunchTemplate({ ...wallets, policyVersion: 'mskd-v1', migrationQuoteThreshold: '68' }),
    /quote mint/
  );
  assert.throws(
    () => buildWalletLaunchTemplate({ ...wallets, policyVersion: 'mskd-v1', quoteMint }),
    /bonding target/
  );
});
