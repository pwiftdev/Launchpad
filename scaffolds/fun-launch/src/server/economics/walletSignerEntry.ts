import { Connection, Keypair } from '@solana/web3.js';
import { database } from '../database';
import { WalletStore } from './walletStore';
import { validateSignedTransaction } from './chainEvidence';
import { validateWalletSignJob, WALLET_SIGN_PROTOCOL } from './walletSigner';
import type { WalletJob } from './walletTypes';
import {
  readPrivateSignerJson,
  walletSignerConfig,
  WALLET_SIGNER_ENVIRONMENT,
} from './walletSignerConfig';

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log(
      'Company-wallet sign-only process: --config /absolute/private/policy.json [--check-config]. Verifies durable jobs, Meteora instructions, recipients and budgets before loading the key. Never broadcasts.'
    );
    return;
  }
  if (
    args.length < 2 ||
    args.length > 3 ||
    args[0] !== '--config' ||
    (args[2] && args[2] !== '--check-config')
  )
    throw new Error('Invalid signer arguments');
  const policy = walletSignerConfig(readPrivateSignerJson(args[1]!, 32768));
  for (const key of WALLET_SIGNER_ENVIRONMENT) delete process.env[key];
  Object.assign(process.env, policy.environment, {
    NODE_ENV: policy.environment.NEXT_PUBLIC_NETWORK === 'localnet' ? 'test' : 'production',
  });
  if (args[2] === '--check-config') {
    console.log(
      JSON.stringify({
        configured: true,
        privateKeyLoaded: false,
        transactionsSigned: 0,
        transactionsBroadcast: 0,
      })
    );
    return;
  }
  const timer = setTimeout(() => {
    console.error('Wallet signer timed out; private settings withheld.');
    process.exit(1);
  }, 25000);
  timer.unref();
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 8192) throw new Error('Oversized signing request');
  }
  const request = JSON.parse(input) as { protocol: string; job: WalletJob };
  if (request.protocol !== WALLET_SIGN_PROTOCOL || !request.job)
    throw new Error('Invalid signing protocol');
  const rpc = new Connection(process.env.RPC_URL!, {
    commitment: 'finalized',
    disableRetryOnRateLimit: true,
    fetch: (url, init) =>
      fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10000) }),
  });
  const checked = await validateWalletSignJob(request.job, rpc, new WalletStore(), policy.limits);
  const secret = readPrivateSignerJson(policy.keyFile, 4096);
  if (
    !Array.isArray(secret) ||
    secret.length !== 64 ||
    !secret.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
  )
    throw new Error('Invalid signing key');
  const bytes = Uint8Array.from(secret);
  secret.fill(0);
  try {
    const key = Keypair.fromSecretKey(bytes);
    try {
      if (!key.publicKey.equals(checked.collector))
        throw new Error('Signing key identity mismatch');
      checked.transaction.partialSign(key);
      const wire = checked.transaction.serialize().toString('base64'),
        signed = validateSignedTransaction(wire, request.job.message_digest!);
      process.stdout.write(
        JSON.stringify({
          protocol: WALLET_SIGN_PROTOCOL,
          jobId: request.job.id,
          messageDigest: request.job.message_digest,
          signedTransactionBase64: wire,
          signature: signed.signature,
        }) + '\n'
      );
    } finally {
      key.secretKey.fill(0);
    }
  } finally {
    bytes.fill(0);
    clearTimeout(timer);
    await database().end();
  }
}
main().catch(() => {
  console.error(
    'Wallet signer rejected the request. Private configuration, keys and upstream responses were withheld.'
  );
  process.exitCode = 1;
});
