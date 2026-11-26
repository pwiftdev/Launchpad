/* One reviewed stock-Meteora config generator; no key generation, RPC, signing or sending. */
const fs = require('node:fs'),
  path = require('node:path');
const { PublicKey } = require('@solana/web3.js');
const sdk = require('@meteora-ag/dynamic-bonding-curve-sdk');
const { inspectLaunchConfig, modeForPolicy, reviewedQuote } = require('./launch-policy.cjs');
const bondPolicy = require('../scaffolds/fun-launch/src/constants/bondPolicy.json');
const modePolicy = require('../scaffolds/fun-launch/src/constants/modePolicy.json');
exports.buildWalletLaunchTemplate = function buildWalletLaunchTemplate({
  collector,
  treasury,
  policyVersion = 'bond-v1',
}) {
  const mode = modeForPolicy(policyVersion);
  if (!['bond-v1', 'wallet-v1'].includes(policyVersion) && !mode)
    throw new Error('Unknown wallet launch policy');
  const feeClaimer = new PublicKey(collector),
    leftoverReceiver = new PublicKey(treasury);
  for (const key of [feeClaimer, leftoverReceiver])
    if (key.equals(PublicKey.default) || !PublicKey.isOnCurve(key.toBytes()))
      throw new Error('Explicit ordinary company wallets are required');
  const parsed = require('typescript').parseConfigFileTextToJson(
    'dbc_config.jsonc',
    fs.readFileSync(path.resolve(__dirname, '../studio/config/dbc_config.jsonc'), 'utf8')
  );
  if (
    parsed.error ||
    parsed.config?.dryRun !== true ||
    parsed.config.dbcConfig?.buildCurveMode !== 0 ||
    parsed.config.quoteMint !== 'So11111111111111111111111111111111111111112'
  )
    throw new Error('Unexpected canonical launch template');
  const {
    buildCurveMode,
    feeClaimer: _oldFeeClaimer,
    leftoverReceiver: _oldReceiver,
    ...params
  } = parsed.config.dbcConfig;
  const quote = reviewedQuote(policyVersion);
  if (mode) {
    const schedule = modePolicy.schedule;
    params.fee = {
      ...params.fee,
      baseFeeParams: {
        baseFeeMode: schedule.baseFeeMode,
        feeSchedulerParam: {
          startingFeeBps: schedule.startingFeeBps,
          endingFeeBps: schedule.endingFeeBps,
          numberOfPeriod: schedule.periods,
          totalDuration: schedule.periodSlots,
        },
      },
      dynamicFeeEnabled: false,
      enableFirstSwapWithMinFee: schedule.enableFirstSwapWithMinFee,
    };
    params.migration = {
      ...params.migration,
      migratedPoolFee: { collectFeeMode: 0, dynamicFee: 0, poolFeeBps: schedule.migrationFeeBps },
    };
    params.activationType = schedule.activationType;
    const { decimals } = modePolicy.quotes[mode.quote];
    params.token = { ...params.token, tokenQuoteDecimal: decimals };
    params.migrationQuoteThreshold = Number(quote.migrationQuoteThreshold) / 10 ** decimals;
  } else if (policyVersion === 'bond-v1') {
    params.fee = {
      ...params.fee,
      baseFeeParams: {
        baseFeeMode: bondPolicy.baseFeeMode,
        feeSchedulerParam: {
          startingFeeBps: bondPolicy.startingFeeBps,
          endingFeeBps: bondPolicy.endingFeeBps,
          numberOfPeriod: bondPolicy.periods,
          totalDuration: bondPolicy.periodSlots,
        },
      },
      dynamicFeeEnabled: false,
      enableFirstSwapWithMinFee: true,
    };
    params.migration = {
      ...params.migration,
      migratedPoolFee: { collectFeeMode: 0, dynamicFee: 0, poolFeeBps: bondPolicy.migrationFeeBps },
    };
    params.activationType = bondPolicy.activationType;
  }
  const built = sdk.buildCurve(params),
    config = {
      ...built,
      quoteMint: new PublicKey(quote.quoteMint),
      feeClaimer,
      leftoverReceiver,
    };
  const normalized = {
    ...config,
    preMigrationTokenSupply: built.tokenSupply?.preMigrationTokenSupply,
    postMigrationTokenSupply: built.tokenSupply?.postMigrationTokenSupply,
    migratedCollectFeeMode: built.migratedPoolFee.collectFeeMode,
    migratedDynamicFee: built.migratedPoolFee.dynamicFee,
    migratedPoolFeeBps: built.migratedPoolFee.poolFeeBps,
    migrationFeePercentage: built.migrationFee.feePercentage,
    creatorMigrationFeePercentage: built.migrationFee.creatorFeePercentage,
  };
  if (
    inspectLaunchConfig(normalized, {
      feeClaimer: feeClaimer.toBase58(),
      leftoverReceiver: leftoverReceiver.toBase58(),
      policyVersion,
    }).length
  )
    throw new Error('Canonical template differs from wallet launch policy');
  return config;
};
