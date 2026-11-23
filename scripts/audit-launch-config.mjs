import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { inspectLaunchConfig, decodeLaunchConfig } from './launch-policy.cjs';
import { companyWallets } from './company-wallets.cjs';
import { buildWalletLaunchTemplate } from './wallet-launch-template.cjs';
import { expectedNetworkGenesis, localValidatorPolicy } from './network-policy.cjs';
const app = createRequire(new URL('../scaffolds/fun-launch/package.json', import.meta.url)),
  policy = app('./src/constants/bondPolicy.json'),
  args = process.argv.slice(2);
if (
  args.length > 1 ||
  args.some((arg) => !['--template', '--devnet', '--localnet'].includes(arg))
) {
  console.error(
    'Use --template for offline canonical wallet policy, --devnet, --localnet for a pinned isolated validator, or no arguments for the configured network. This check never signs, sends or changes registry/gates.'
  );
  process.exit(1);
}
try {
  const sdk = app('@meteora-ag/dynamic-bonding-curve-sdk'),
    { Connection, PublicKey } = app('@solana/web3.js'),
    offline = args.includes('--template');
  const selected = args.includes('--localnet')
    ? 'localnet'
    : args.includes('--devnet')
      ? 'devnet'
      : process.env.NEXT_PUBLIC_NETWORK || 'mainnet-beta';
  const env = { ...process.env, NEXT_PUBLIC_NETWORK: selected };
  if (selected === 'localnet' && !localValidatorPolicy(env))
    throw Error('Invalid isolated validator policy');
  const expected = expectedNetworkGenesis(env),
    wallets = companyWallets(env, expected),
    authorities = {
      feeClaimer: wallets.collector.toBase58(),
      leftoverReceiver: wallets.treasury.toBase58(),
      policyVersion: 'bond-v1',
    };
  let config,
    address,
    digest,
    actualGenesis = null;
  if (offline)
    config = buildWalletLaunchTemplate({
      collector: wallets.collector,
      treasury: wallets.treasury,
    });
  else {
    if (!env.RPC_URL || !env.POOL_CONFIG_KEY) throw Error('Explicit RPC/config required');
    const rpc = new Connection(env.RPC_URL, {
      commitment: 'finalized',
      disableRetryOnRateLimit: true,
      fetch: (url, init) =>
        fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15000) }),
    });
    actualGenesis = await rpc.getGenesisHash();
    if (actualGenesis !== expected) throw Error('Wrong RPC network');
    const key = new PublicKey(env.POOL_CONFIG_KEY),
      account = await rpc.getAccountInfo(key, 'finalized');
    if (!account?.owner.equals(sdk.DYNAMIC_BONDING_CURVE_PROGRAM_ID) || account.executable)
      throw Error('Wrong DBC configuration owner');
    config = decodeLaunchConfig(account.data);
    digest = createHash('sha256').update(account.data).digest('hex');
    address = key.toBase58();
    if ((await rpc.getGenesisHash()) !== expected) throw Error('RPC network changed');
  }
  // The shared SDK template generator already performs the identical full policy check.
  const issues = offline ? [] : inspectLaunchConfig(config, authorities);
  if (!offline && env.EXPECTED_CONFIG_DIGEST && digest !== env.EXPECTED_CONFIG_DIGEST)
    issues.push({ field: 'configDigest', expected: env.EXPECTED_CONFIG_DIGEST, actual: digest });
  const base = config.poolFees.baseFee;
  const endpoint =
    Number(
      sdk
        .getFeeSchedulerMinBaseFeeNumerator(
          base.cliffFeeNumerator,
          base.firstFactor,
          base.thirdFactor,
          base.baseFeeMode
        )
        .toString()
    ) / 10_000_000;
  console.log(
    JSON.stringify(
      {
        network: offline ? 'offline template' : selected,
        networkGenesis: actualGenesis,
        policyVersion: 'bond-v1',
        address,
        configDigest: digest,
        economicPolicyMatches: issues.length === 0,
        startingTaxPercent: policy.startingFeeBps / 100,
        targetPercent: policy.endingFeeBps / 100,
        scheduledEndpointPercent: endpoint,
        authorities,
        authorityReview:
          'Ordinary company wallet addresses checked. Private-key control is not established by this read-only check.',
        issues,
        financialReleaseReady: false,
        mainnetGateOpened: false,
        readOnly: true,
        transactionsSigned: 0,
        transactionsBroadcast: 0,
        note: 'Configuration policy check only; no signing, sending, registry writes or release-gate changes.',
      },
      null,
      2
    )
  );
  if (issues.length) process.exitCode = 1;
} catch {
  console.error(
    'Wallet configuration review failed. Check explicit company wallets, the expected network and the config account or canonical template. No settings, registry entries or on-chain state were changed.'
  );
  process.exitCode = 1;
}
