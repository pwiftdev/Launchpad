import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { inspectLaunchConfig, decodeLaunchConfig } from './launch-policy.cjs';
import { companyWallets } from './company-wallets.cjs';
import { expectedNetworkGenesis } from './network-policy.cjs';
import { databaseConfig } from './postgres-config.cjs';
const app = createRequire(new URL('../scaffolds/fun-launch/package.json', import.meta.url)),
  args = process.argv.slice(2);
if (
  args.some((arg) => !['--write', '--enable'].includes(arg)) ||
  new Set(args).size !== args.length ||
  (args.includes('--enable') && !args.includes('--write'))
) {
  console.error(
    'Use no arguments for read-only bond-v1 configuration verification; --write persists the reviewed record, --write --enable enables new preparations. No chain transaction is sent.'
  );
  process.exit(1);
}
try {
  const { Connection, PublicKey } = app('@solana/web3.js'),
    sdk = app('@meteora-ag/dynamic-bonding-curve-sdk');
  if (
    !process.env.RPC_URL ||
    !process.env.POOL_CONFIG_KEY ||
    !/^[a-f0-9]{64}$/.test(process.env.EXPECTED_CONFIG_DIGEST ?? '')
  )
    throw Error('Independent config key/digest required');
  const key = new PublicKey(process.env.POOL_CONFIG_KEY),
    connection = new Connection(process.env.RPC_URL, {
      commitment: 'finalized',
      disableRetryOnRateLimit: true,
      fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(15000) }),
    });
  const genesis = await connection.getGenesisHash();
  if (genesis !== expectedNetworkGenesis(process.env)) throw Error('Wrong RPC genesis');
  const { collector, treasury } = companyWallets(process.env, genesis),
    { context, value } = await connection.getAccountInfoAndContext(key, 'finalized');
  if (!value?.owner.equals(sdk.DYNAMIC_BONDING_CURVE_PROGRAM_ID) || value.executable)
    throw Error('Wrong config owner');
  const digest = createHash('sha256').update(value.data).digest('hex');
  if (digest !== process.env.EXPECTED_CONFIG_DIGEST)
    throw Error('Config differs from independently expected digest');
  const config = decodeLaunchConfig(value.data),
    issues = inspectLaunchConfig(config, {
      feeClaimer: collector.toBase58(),
      leftoverReceiver: treasury.toBase58(),
      policyVersion: 'bond-v1',
    });
  if (issues.length) {
    console.log(JSON.stringify({ verified: false, policyVersion: 'bond-v1', issues }, null, 2));
    process.exitCode = 1;
  } else {
    if ((await connection.getGenesisHash()) !== genesis) throw Error('RPC network changed');
    let registryEnabled = null;
    if (args.includes('--write')) {
      const { Pool } = app('pg'),
        pool = new Pool(databaseConfig());
      try {
        await pool.query(
          `INSERT INTO launch_configs(network_genesis,config_key,policy_version,expected_fee_claimer,expected_leftover_receiver,config_digest,enabled_for_launch,verified_slot) VALUES($1,$2,'bond-v1',$3,$4,$5,$6,$7) ON CONFLICT(network_genesis,config_key) DO NOTHING`,
          [
            genesis,
            key.toBase58(),
            collector.toBase58(),
            treasury.toBase58(),
            digest,
            args.includes('--enable'),
            context.slot,
          ]
        );
        const row = (
          await pool.query(
            'SELECT * FROM launch_configs WHERE network_genesis=$1 AND config_key=$2',
            [genesis, key.toBase58()]
          )
        ).rows[0];
        if (
          !row ||
          row.policy_version !== 'bond-v1' ||
          row.config_digest !== digest ||
          row.expected_fee_claimer !== collector.toBase58() ||
          row.expected_leftover_receiver !== treasury.toBase58()
        )
          throw Error('Immutable registry conflict');
        if (args.includes('--enable'))
          await pool.query(
            'UPDATE launch_configs SET enabled_for_launch=true WHERE network_genesis=$1 AND config_key=$2',
            [genesis, key.toBase58()]
          );
        registryEnabled = args.includes('--enable') || row.enabled_for_launch;
      } finally {
        await pool.end();
      }
    }
    console.log(
      JSON.stringify(
        {
          verified: true,
          policyVersion: 'bond-v1',
          networkGenesis: genesis,
          configKey: key.toBase58(),
          configDigest: digest,
          feeCollector: collector.toBase58(),
          treasury: treasury.toBase58(),
          wroteRegistry: args.includes('--write'),
          registryEnabled,
          enableRequested: args.includes('--enable'),
          mainnetTradingEnabled: false,
        },
        null,
        2
      )
    );
  }
} catch {
  console.error(
    'Wallet launch config registration failed. Check explicit company wallets, independently expected config digest, finalized network policy, and database migration. No on-chain transaction was sent.'
  );
  process.exitCode = 1;
}
