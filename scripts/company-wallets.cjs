const { PublicKey } = require('@solana/web3.js');
const owner = require('../docs/mainnet-authorities.public.json');
const devCompany = require('../docs/mskd-mainnet-dev-wallets.public.json');
const { MAINNET_REWARD_PINS, NETWORK_GENESIS } = require('./network-policy.cjs');

function pinnedMainnetCompanyWallets(policyVersion) {
  return policyVersion === 'dev-v1' || Object.hasOwn(MAINNET_REWARD_PINS, policyVersion)
    ? devCompany
    : (owner.company ?? { collector: owner.vault.operator, treasury: owner.vault.treasury });
}
exports.pinnedMainnetCompanyWallets = pinnedMainnetCompanyWallets;

exports.companyWallets = function companyWallets(env, genesis, options = {}) {
  const collectorKey = env.FEE_COLLECTOR_PUBLIC_KEY,
    treasuryKey = env.TREASURY_PUBLIC_KEY;
  if (!collectorKey || !treasuryKey)
    throw new Error('Explicit fee collector and treasury wallets are required');
  const collector = new PublicKey(collectorKey),
    treasury = new PublicKey(treasuryKey);
  if (
    [collector, treasury].some(
      (key) => key.equals(PublicKey.default) || !PublicKey.isOnCurve(key.toBytes())
    )
  )
    throw new Error('Company fee destinations must be ordinary wallet addresses');
  if (genesis === NETWORK_GENESIS['mainnet-beta']) {
    const current = pinnedMainnetCompanyWallets(env.LAUNCH_POLICY_VERSION);
    const matches = (record) =>
      collectorKey === record.collector && treasuryKey === record.treasury;
    const historical =
      env.LAUNCH_POLICY_VERSION !== 'dev-v1' &&
      env.LAUNCH_POLICY_VERSION !== 'masked-v1' &&
      options.allowLegacy === true &&
      (owner.legacyCompanyWallets ?? []).some(
        (record) => record.policyVersion === 'wallet-v1' && matches(record)
      );
    if (!matches(current) && !historical)
      throw new Error('Mainnet company wallets differ from the owner-provided public record');
  }
  return { collector, treasury };
};
