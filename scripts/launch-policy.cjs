const legacyPolicy = require('../scaffolds/fun-launch/src/constants/launchPolicy.json');
const bondPolicy = require('../scaffolds/fun-launch/src/constants/bondPolicy.json');
const modePolicy = require('../scaffolds/fun-launch/src/constants/modePolicy.json');
const SOL_MINT = 'So11111111111111111111111111111111111111112';
/** MSKD launch modes share one flat schedule; each pins its own quote mint and threshold. */
const modeForPolicy = (version) =>
  Object.values(modePolicy.modes).find((mode) => mode.policyVersion === version) ?? null;
exports.modeForPolicy = modeForPolicy;
exports.verifyQuoteMint = async function verifyQuoteMint(connection, mint) {
  const { getMint, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
  const state = await getMint(connection, new PublicKey(mint), 'finalized', TOKEN_PROGRAM_ID);
  if (!state.isInitialized || state.decimals !== 9)
    throw new Error('The reviewed quote mint must use nine decimals and the standard SPL token program');
};
// Every reviewed launch policy pairs to SOL with the 80 SOL bonding target. MSKD pays holders
// in wXMR, but its curve, config and fee claims are SOL.
exports.reviewedQuote = function reviewedQuote() {
  return { quoteMint: SOL_MINT, migrationQuoteThreshold: '80000000000' };
};
const { PublicKey } = require('@solana/web3.js');
const { BorshCoder } = require('@coral-xyz/anchor');
const { convertIdlToCamelCase } = require('@coral-xyz/anchor/dist/cjs/idl.js');
const { DynamicBondingCurveIdl } = require('@meteora-ag/dynamic-bonding-curve-sdk');
let accountCoder;
exports.decodeLaunchConfig = function decodeLaunchConfig(bytes) {
  if (!accountCoder) {
    accountCoder = new BorshCoder(convertIdlToCamelCase(DynamicBondingCurveIdl));
  }
  return accountCoder.accounts.decode('poolConfig', bytes);
};

// A read-only economic configuration check. Passing is not permission to enable trading.
exports.inspectLaunchConfig = function inspectLaunchConfig(config, expected = {}) {
  const mode = modeForPolicy(expected.policyVersion);
  // Mode policies use the same one-slot guard mechanics as Bond it., with a flat 1.25% after.
  const bond = expected.policyVersion === 'bond-v1' || mode !== null;
  const scheduled = mode ? modePolicy.schedule : bondPolicy;
  const policy = bond ? scheduled : legacyPolicy;
  const issues = [];
  const check = (field, actual, intended) => {
    if (actual === undefined || actual === null || String(actual) !== String(intended))
      issues.push({
        field,
        expected: String(intended),
        actual: actual == null ? null : String(actual),
      });
  };
  const base = config.poolFees?.baseFee ?? {};
  check('startingFeeNumerator', base.cliffFeeNumerator, policy.startingFeeBps * 100_000);
  check('schedulerMode', base.baseFeeMode, bond ? scheduled.baseFeeMode : 1);
  check('periods', base.firstFactor, policy.periods);
  check('stepSeconds', base.secondFactor, bond ? scheduled.periodSlots : policy.stepSeconds);
  check(
    'reductionBps',
    base.thirdFactor,
    bond ? scheduled.reductionBps * 100_000 : policy.reductionBps
  );
  if (bond) check('enableFirstSwapWithMinFee', Number(config.enableFirstSwapWithMinFee), 1);
  if (!config.poolFees || !Object.hasOwn(config.poolFees, 'dynamicFee'))
    issues.push({ field: 'dynamicFee', expected: 'Explicitly disabled', actual: null });
  check('dynamicFeeEnabled', Number(config.poolFees?.dynamicFee?.initialized ?? 0), 0);
  check('collectFeeMode', config.collectFeeMode, 0);
  check('activationType', config.activationType, bond ? scheduled.activationType : 1);
  if (mode && mode.quote !== 'sol') {
    // A non-SOL pair (none today) must be pinned by the caller.
    if (!expected.quoteMint || expected.quoteMint === SOL_MINT)
      issues.push({ field: 'quoteMint', expected: 'An independently pinned quote mint', actual: null });
    else check('quoteMint', config.quoteMint, expected.quoteMint);
    if (!/^[1-9][0-9]*$/.test(String(expected.migrationQuoteThreshold ?? '')))
      issues.push({ field: 'migrationQuoteThreshold', expected: 'A reviewed raw quote threshold', actual: null });
    else check('migrationQuoteThreshold', config.migrationQuoteThreshold, expected.migrationQuoteThreshold);
  } else {
    check('quoteMint', config.quoteMint, SOL_MINT);
    check('migrationQuoteThreshold', config.migrationQuoteThreshold, '80000000000');
  }
  check('tokenDecimal', config.tokenDecimal, 6);
  check('tokenType', config.tokenType, 0);
  check('tokenUpdateAuthority', config.tokenUpdateAuthority, 1);
  check('preMigrationTokenSupply', config.preMigrationTokenSupply, '1000000000000000');
  check('postMigrationTokenSupply', config.postMigrationTokenSupply, '1000000000000000');
  check('migrationOption', config.migrationOption, 1);
  check('migrationFeeOption', config.migrationFeeOption, 6);
  check('migratedCollectFeeMode', config.migratedCollectFeeMode, 0);
  check('migratedDynamicFee', config.migratedDynamicFee, 0);
  check('migratedPoolFeeBps', config.migratedPoolFeeBps, policy.migrationFeeBps);
  check('migratedPoolBaseFeeMode', config.migratedPoolBaseFeeMode, 0);
  check('creatorTradingFeePercentage', config.creatorTradingFeePercentage, 0);
  check(
    'partnerPermanentLockedLiquidityPercentage',
    config.partnerPermanentLockedLiquidityPercentage,
    100
  );
  check('partnerLiquidityPercentage', config.partnerLiquidityPercentage, 0);
  check(
    'creatorPermanentLockedLiquidityPercentage',
    config.creatorPermanentLockedLiquidityPercentage,
    0
  );
  check('creatorLiquidityPercentage', config.creatorLiquidityPercentage, 0);
  check('poolCreationFee', config.poolCreationFee, 0);
  check('migrationFeePercentage', config.migrationFeePercentage, 0);
  check('creatorMigrationFeePercentage', config.creatorMigrationFeePercentage, 0);
  for (const field of ['feeClaimer', 'leftoverReceiver']) {
    if (!expected[field] || expected[field] === '11111111111111111111111111111111')
      issues.push({ field, expected: 'An independently reviewed authority address', actual: null });
    else check(field, config[field], expected[field]);
  }
  if (expected.policyVersion === 'wallet-v1' || bond || mode) {
    // Caller supplies independently pinned company wallets; a PDA/native-vault route
    // cannot silently replace this wallet-operated settlement policy.
    for (const field of ['feeClaimer', 'leftoverReceiver']) {
      try {
        const key = new PublicKey(expected[field]);
        if (key.equals(PublicKey.default) || !PublicKey.isOnCurve(key.toBytes())) throw Error();
      } catch {
        issues.push({
          field: `${field}Wallet`,
          expected: 'An independently pinned ordinary company wallet',
          actual: null,
        });
      }
    }
  }
  return issues;
};
