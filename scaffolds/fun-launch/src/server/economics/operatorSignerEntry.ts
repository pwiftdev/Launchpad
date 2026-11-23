import fs from 'node:fs';
import path from 'node:path';
import { Connection, Keypair } from '@solana/web3.js';
import { operatorSignerPolicy, validateOperatorSignRequest } from './operatorSignerPolicy';
import { validateSignedTransaction } from './chainEvidence';

function privateFile(file: string, maximum: number, read = true) {
  if (!path.isAbsolute(file)) throw new Error('Absolute private file required');
  const unix = process.platform !== 'win32',
    uid = process.getuid?.(),
    parent = fs.lstatSync(path.dirname(file));
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    (unix &&
      ((parent.mode & 0o022) !== 0 ||
        (parent.uid !== 0 && parent.uid !== uid) ||
        fs.realpathSync(file) !== path.resolve(file)))
  )
    throw new Error('Private file directory rejected');
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Private file type rejected');
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)
  );
  try {
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.ino !== before.ino ||
      stat.dev !== before.dev ||
      stat.size > maximum ||
      (unix && ((stat.mode & 0o077) !== 0 || stat.uid !== uid))
    )
      throw new Error('Private file permissions or type rejected');
    if (!read) return null;
    const buffer = Buffer.alloc(maximum + 1);
    let length = 0;
    try {
      while (length < buffer.length) {
        const received = fs.readSync(fd, buffer, length, buffer.length - length, null);
        if (received === 0) break;
        length += received;
      }
      if (length > maximum) throw new Error('Private file capacity exceeded');
      return JSON.parse(buffer.subarray(0, length).toString('utf8')) as unknown;
    } finally {
      buffer.fill(0);
    }
  } finally {
    fs.closeSync(fd);
  }
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log(
      'Restricted sign-only worker: --config /absolute/private/policy.json [--check-config]. Reads one bounded JSON request from stdin; verifies native code, custody, message and limits before loading a separate signing key. No broadcast or governance signing.'
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
  const policy = operatorSignerPolicy.parse(privateFile(args[1]!, 16384));
  if (!path.isAbsolute(policy.keyFile)) throw new Error('Absolute signing key path required');
  privateFile(policy.keyFile, 4096, false);
  if (args[2] === '--check-config') {
    console.log(
      JSON.stringify({
        version: 1,
        configured: true,
        role: policy.role,
        publicKey: policy.role === 'operator' ? policy.operator : policy.treasury,
        privateKeyLoaded: false,
        signingIdentityVerified: false,
        nativeAccountsVerified: false,
        transactionsSigned: 0,
        transactionsBroadcast: 0,
      })
    );
    return;
  }
  const timer = setTimeout(() => {
    console.error('Restricted signer timed out; private settings withheld.');
    process.exit(1);
  }, 25000);
  timer.unref();
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 16384) throw new Error('Oversized signing request');
  }
  const request = JSON.parse(input) as unknown;
  const rpc = new Connection(policy.rpcUrl, {
    commitment: 'finalized',
    disableRetryOnRateLimit: true,
    fetch: async (url, init) => {
      const response = await fetch(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
      if (!response.body) throw new Error('RPC response unavailable');
      const reader = response.body.getReader(),
        chunks: Buffer[] = [];
      let total = 0;
      try {
        for (;;) {
          const item = await reader.read();
          if (item.done) break;
          total += item.value.byteLength;
          if (total > 16 * 1024 * 1024) throw new Error('RPC response limit');
          chunks.push(Buffer.from(item.value));
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      return new Response(Buffer.concat(chunks), {
        status: response.status,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  const verified = await validateOperatorSignRequest(request, policy, rpc);
  const secret = privateFile(policy.keyFile, 4096);
  if (
    !Array.isArray(secret) ||
    secret.length !== 64 ||
    !secret.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
  )
    throw new Error('Invalid signing key');
  const bytes = Uint8Array.from(secret);
  secret.fill(0);
  try {
    const key = Keypair.fromSecretKey(bytes);
    if (
      key.publicKey.toBase58() !== (policy.role === 'operator' ? policy.operator : policy.treasury)
    )
      throw new Error('Signing key identity mismatch');
    verified.transaction.sign([key]);
    const signedTransactionBase64 = Buffer.from(verified.transaction.serialize()).toString(
        'base64'
      ),
      signed = validateSignedTransaction(signedTransactionBase64, verified.request.messageDigest);
    const value = verified.request;
    process.stdout.write(
      JSON.stringify({
        version: 1,
        purpose: 'rinsed-financial-sign-only',
        requestId: value.requestId,
        networkGenesis: value.networkGenesis,
        vaultProgramId: value.vaultProgramId,
        executionId: value.executionId,
        messageDigest: value.messageDigest,
        feePayer: value.feePayer,
        requiredSigners: value.requiredSigners,
        signedTransactionBase64,
        signature: signed.signature,
      }) + '\n'
    );
    clearTimeout(timer);
  } finally {
    bytes.fill(0);
  }
}
main().catch(() => {
  console.error(
    'Restricted signer rejected the request. Private configuration, key material and upstream responses were withheld.'
  );
  process.exitCode = 1;
});
