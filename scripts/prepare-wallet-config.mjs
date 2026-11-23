import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { prepareWalletConfiguration } from './wallet-config-preparation.cjs';
import { companyWallets } from './company-wallets.cjs';
import { NETWORK_GENESIS } from './network-policy.cjs';
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log(
    'Prepare the existing Meteora launch configuration: --connection-file .local/mainnet-connection.private.json --output .local/wallet-config.private.json. Creates one private configuration-account key and an unsigned transaction for the owner wallet. Never signs, broadcasts, deploys a program, changes the database or opens trading.'
  );
} else {
  try {
    if (args.length !== 4 || args[0] !== '--connection-file' || args[2] !== '--output')
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
    const connectionFile = privatePath(args[1]),
      output = privatePath(args[3]),
      stat = fs.lstatSync(connectionFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32768 || fs.existsSync(output))
      throw Error('New output and bounded private connection input required');
    const connection = JSON.parse(fs.readFileSync(connectionFile, 'utf8')),
      url = new URL(connection.rpcUrl);
    if (
      connection.expectedGenesis !== NETWORK_GENESIS['mainnet-beta'] ||
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash
    )
      throw Error('Pinned private mainnet connection required');
    const app = createRequire(new URL('../scaffolds/fun-launch/package.json', import.meta.url)),
      { Connection, Keypair } = app('@solana/web3.js');
    const rpc = new Connection(url.href, {
      commitment: 'finalized',
      disableRetryOnRateLimit: true,
      fetch: (url, init) =>
        fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15000) }),
    });
    const publicRoles = JSON.parse(
      fs.readFileSync(new URL('../docs/mainnet-authorities.public.json', import.meta.url), 'utf8')
    );
    const { collector, treasury } = companyWallets(
      {
        FEE_COLLECTOR_PUBLIC_KEY: publicRoles.company?.collector ?? publicRoles.vault.operator,
        TREASURY_PUBLIC_KEY: publicRoles.company?.treasury ?? publicRoles.vault.treasury,
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
          policy: 'bond-v1',
          configKey: prepared.configKey,
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
