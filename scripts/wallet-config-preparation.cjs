/* Existing Meteora configuration only. No custom program, signing or broadcast. */
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const path = require('node:path');
const app = createRequire(path.resolve(__dirname, '../scaffolds/fun-launch/package.json'));
const sdk = app('@meteora-ag/dynamic-bonding-curve-sdk');
const { buildWalletLaunchTemplate } = require('./wallet-launch-template.cjs');
async function prepareWalletConfiguration({ rpc, genesis, collector, treasury, configKey, policyVersion = 'bond-v1', quoteMint, migrationQuoteThreshold }) {
  if ((await rpc.getGenesisHash()) !== genesis) throw Error('Preparation network mismatch');
  const client = new sdk.DynamicBondingCurveClient(rpc, 'finalized');
  const tx = await client.partner.createConfig({
    config: configKey,
    payer: collector,
    ...buildWalletLaunchTemplate({ collector, treasury, policyVersion, quoteMint, migrationQuoteThreshold }),
  });
  if (
    tx.instructions.length !== 1 ||
    !tx.instructions[0].programId.equals(sdk.DYNAMIC_BONDING_CURVE_PROGRAM_ID)
  )
    throw Error('Unexpected configuration instructions');
  const latest = await rpc.getLatestBlockhashAndContext('finalized');
  tx.feePayer = collector;
  tx.recentBlockhash = latest.value.blockhash;
  const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  if (bytes.length > 1232 || tx.compileMessage().header.numRequiredSignatures !== 2)
    throw Error('Invalid stock configuration transaction');
  const cost = await rpc.getFeeForMessage(tx.compileMessage(), 'finalized');
  if (
    !Number.isSafeInteger(cost.value) ||
    cost.value <= 0 ||
    (await rpc.getGenesisHash()) !== genesis
  )
    throw Error('Configuration cost/network unavailable');
  return {
    version: 1,
    policy: policyVersion,
    networkGenesis: genesis,
    configKey: configKey.toBase58(),
    collector: collector.toBase58(),
    treasury: treasury.toBase58(),
    preparedSlot: latest.context.slot,
    lastValidBlockHeight: latest.value.lastValidBlockHeight,
    transactionBase64: bytes.toString('base64'),
    messageDigest: createHash('sha256').update(tx.serializeMessage()).digest('hex'),
    transactionBytes: bytes.length,
    networkFeeLamports: cost.value.toString(),
    requiredSigners: [collector.toBase58(), configKey.toBase58()],
    transactionsSigned: 0,
    transactionsBroadcast: 0,
  };
}
module.exports = { prepareWalletConfiguration };
