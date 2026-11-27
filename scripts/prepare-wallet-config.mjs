import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { prepareWalletConfiguration } from './wallet-config-preparation.cjs';
import { companyWallets, pinnedMainnetCompanyWallets } from './company-wallets.cjs';
import { NETWORK_GENESIS } from './network-policy.cjs';
import { modeForPolicy } from './launch-policy.cjs';
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log(
    'Prepare a Meteora config without signing or broadcasting. Use --mainnet-masked and a private connection file, or --devnet masked and explicit FEE_COLLECTOR_PUBLIC_KEY and TREASURY_PUBLIC_KEY. End with --output and a new private path. The other reviewed modes and the Bond it. --connection-file option remain supported.'
  );
} else {
  try {
    const devnet = args[0] === '--devnet';
    const mainnetMode = /^--mainnet-([a-z-]+)$/.exec(args[0] ?? '')?.[1];
    const policyVersion = devnet ? `${args[1]}-v1` : mainnetMode ? `${mainnetMode}-v1` : 'bond-v1';
    if (
      args.length !== 4 ||
      (!devnet && !mainnetMode && args[0] !== '--connection-file') ||
      args[2] !== '--output' ||
      ((devnet || mainnetMode) && !modeForPolicy(policyVersion))
    )
      throw Error('Invalid preparation arguments');
    const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
      local = path.join(workspace, '.local');
    function privatePath(value) {
      const file = path.resolve(value);
      if (
        path.dirname(file) !== local ||
        !file.endsWith('.private.json') ||
        fs.lstatSync(local).isSymbolicLink()
      )
        throw Error('Ignored local private path required');
      return file;
    }
    const output = privatePath(args[3]);
    if (fs.existsSync(output)) throw Error('A new ignored private output path is required');
    const expectedGenesis = NETWORK_GENESIS[devnet ? 'devnet' : 'mainnet-beta'];
    let connection = {
      rpcUrl: process.env.RPC_URL || 'https://api.devnet.solana.com',
      expectedGenesis,
    };
    if (!devnet) {
      const filename = privatePath(args[1]);
      const stat = fs.lstatSync(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32768)
        throw Error('A bounded private connection input is required');
      connection = JSON.parse(fs.readFileSync(filename, 'utf8'));
    }
    const url = new URL(connection.rpcUrl);
    if (
      connection.expectedGenesis !== expectedGenesis ||
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash
    )
      throw Error('Pinned HTTPS RPC connection required');
    const app = createRequire(new URL('../scaffolds/fun-launch/package.json', import.meta.url)),
      { Connection, Keypair } = app('@solana/web3.js');
    const rpc = new Connection(url.href, {
      commitment: 'finalized',
      disableRetryOnRateLimit: true,
      fetch: (url, init) =>
        fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15000) }),
    });
    const publicRoles = pinnedMainnetCompanyWallets(policyVersion);
    const { collector, treasury } = companyWallets(
      devnet
        ? process.env
        : {
            FEE_COLLECTOR_PUBLIC_KEY: publicRoles.collector,
            TREASURY_PUBLIC_KEY: publicRoles.treasury,
            LAUNCH_POLICY_VERSION: policyVersion,
          },
      connection.expectedGenesis
    );
    const configKey = Keypair.generate();
    try {
      const prepared = await prepareWalletConfiguration({
        rpc,
        genesis: connection.expectedGenesis,
        collector,
        treasury,
        configKey: configKey.publicKey,
        policyVersion,
      });
      fs.writeFileSync(
        output,
        JSON.stringify(
          {
            ...prepared,
            purpose: 'private-stock-meteora-config-preparation',
            configAccountKeypair: [...configKey.secretKey],
          },
          null,
          2
        ) + '\n',
        { flag: 'wx', mode: 0o600 }
      );
      console.log(
        JSON.stringify({
          prepared: true,
          policy: prepared.policy,
          configKey: prepared.configKey,
          collector: prepared.collector,
          treasury: prepared.treasury,
          networkFeeLamports: prepared.networkFeeLamports,
          transactionBytes: prepared.transactionBytes,
          transactionsSigned: 0,
          transactionsBroadcast: 0,
        })
      );
    } finally {
      configKey.secretKey.fill(0);
    }
  } catch {
    console.error(
      'Wallet configuration preparation failed. Check the private connection, new ignored output path and Meteora policy. No transaction was signed or broadcast.'
    );
    process.exitCode = 1;
  }
}
