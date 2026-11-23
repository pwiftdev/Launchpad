/* Install only into the isolated VM rehearsal directory. Never loads application env files. */
const fs = require('node:fs');
const path = require('node:path');
const { createPrivateKey, sign } = require('node:crypto');
const { Connection, Keypair, Transaction } = require('@solana/web3.js');
const bs58 = require('bs58');
const roots = new Map([
  ['devnet-binaries', '/root/rinsed-rehearsal'],
  ['mainnet-binaries', '/root/rinsed-rehearsal-mainnet'],
]);
const allowedRoles = new Set([
  'governor',
  'operator',
  'treasury',
  'creator',
  'community',
  'trader',
  'claimant',
]);

function walletRewardMessageAllowed(text, { genesis, wallet, role, now = Date.now() }) {
  if (typeof text !== 'string' || text.length > 4096 || !allowedRoles.has(role)) return false;
  const lines = text.split('\n');
  if (
    lines.length !== 10 ||
    lines[0] !== 'Request a SOL reward payout on http://127.0.0.1:3003' ||
    lines[1] !== 'Policy: rinsed-wallet-payout-v1' ||
    lines[2] !== `Network genesis: ${genesis}` ||
    lines[3] !== `Wallet: ${wallet}` ||
    !/^Wallet: [1-9A-HJ-NP-Za-km-z]{32,44}$/.test(lines[3]) ||
    !/^Mint: [1-9A-HJ-NP-Za-km-z]{32,44}$/.test(lines[4]) ||
    !/^Epoch: (creator|0|[1-9]\d{0,9})$/.test(lines[5]) ||
    !/^Amount \(lamports\): [1-9]\d{0,19}$/.test(lines[6]) ||
    !/^Request: [a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      lines[7]
    ) ||
    !/^Issued at: [1-9]\d{12}$/.test(lines[8]) ||
    lines[9] !==
      'Send this reward only to the wallet above. No transaction signature or token approval is requested.'
  )
    return false;
  const amount = BigInt(lines[6].slice('Amount (lamports): '.length)),
    issuedAt = Number(lines[8].slice('Issued at: '.length));
  return (
    amount <= 18446744073709551615n &&
    Number.isSafeInteger(issuedAt) &&
    Math.abs(now - issuedAt) <= 300000
  );
}

async function main() {
  if (process.env.NODE_ENV === 'production')
    throw new Error('Local signer unavailable in production');
  if (process.platform !== 'linux' || process.cwd() === '/')
    throw new Error('Use the isolated Linux rehearsal directory');
  let input = '';
  for await (const part of process.stdin) {
    input += part;
    if (input.length > 24000) throw new Error('Oversized transaction request');
  }
  const request = JSON.parse(input);
  const root = roots.get(request.profile);
  if (!root) throw new Error('Unknown isolated signing profile');
  if (!['send', 'sign-only', 'sign-message'].includes(request.action))
    throw new Error('Unknown signer action');
  if (
    !Array.isArray(request.roles) ||
    !request.roles.length ||
    request.roles.some((role) => !allowedRoles.has(role))
  )
    throw new Error('Unknown local signer role');
  const pinned = JSON.parse(fs.readFileSync(path.join(root, 'genesis.json'), 'utf8')).result;
  const connection = new Connection('http://127.0.0.1:8899', 'confirmed');
  if (
    !pinned ||
    [
      '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
      'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
      '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
    ].includes(pinned) ||
    request.networkGenesis !== pinned ||
    (await connection.getGenesisHash()) !== pinned
  )
    throw new Error('Local genesis mismatch');
  if (request.action === 'sign-message') {
    const message = Buffer.from(request.messageBase64, 'base64');
    const text = message.toString('utf8');
    const rewardMessage =
      text.startsWith('Prepare a token reward claim on http://127.0.0.1:3003\n') &&
      text.split('\n').includes(`Network genesis: ${pinned}`) &&
      text.endsWith(
        'This message does not transfer funds. Review and sign the separate claim transaction.'
      );
    const walletLine = text.split('\n').find((line) => line.startsWith('Wallet: ')),
      wallet = walletLine?.slice('Wallet: '.length);
    const walletRewardMessage = walletRewardMessageAllowed(text, {
      genesis: pinned,
      wallet,
      role: request.roles[0],
    });
    const launchMessage =
      request.roles[0] === 'trader' &&
      /^Authorize a token launch on http:\/\/127\.0\.0\.1:3003\nWallet: [1-9A-HJ-NP-Za-km-z]{32,44}\nMint: [1-9A-HJ-NP-Za-km-z]{32,44}\nIssued at: [0-9]{13}\n(?:Launch mode: (?:Creator Fees|Community)\n)?Payload SHA-256: [a-fA-F0-9]{64}\nThis signature authorizes metadata upload only\.$/.test(
        text
      );
    if (
      request.roles.length !== 1 ||
      message.length > 4096 ||
      !Buffer.from(text).equals(message) ||
      (!rewardMessage && !walletRewardMessage && !launchMessage)
    )
      throw new Error(
        'Only approved domain-bound local reward or launch authorization messages are allowed'
      );
    const roleKey = Keypair.fromSecretKey(
      Uint8Array.from(
        JSON.parse(fs.readFileSync(path.join(root, 'keys', request.roles[0] + '.json'), 'utf8'))
      )
    );
    if (!text.split('\n').includes(`Wallet: ${roleKey.publicKey.toBase58()}`))
      throw new Error('Reward authorization wallet differs from the signing role');
    const privateKey = createPrivateKey({
      key: Buffer.concat([
        Buffer.from('302e020100300506032b657004220420', 'hex'),
        Buffer.from(roleKey.secretKey.subarray(0, 32)),
      ]),
      format: 'der',
      type: 'pkcs8',
    });
    process.stdout.write(
      JSON.stringify({
        signatureBase64: sign(null, message, privateKey).toString('base64'),
        publicKey: roleKey.publicKey.toBase58(),
      })
    );
    return;
  }
  const wire = Buffer.from(request.transaction, 'base64');
  if (wire.length > 1232) throw new Error('Transaction exceeds packet size');
  const transaction = Transaction.from(wire);
  // Secret files are consulted only after the fixed loopback connection and genesis are verified.
  for (const role of request.roles) {
    const key = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(fs.readFileSync(path.join(root, 'keys', role + '.json'), 'utf8')))
    );
    if (!transaction.signatures.some((signature) => signature.publicKey.equals(key.publicKey)))
      throw new Error('Requested role is not a transaction signer');
    transaction.partialSign(key);
  }
  const signed = transaction.serialize();
  if (request.action === 'sign-only') {
    process.stdout.write(
      JSON.stringify({
        signedTransactionBase64: signed.toString('base64'),
        signature: bs58.encode(transaction.signature),
      })
    );
    return;
  }
  const signature = await connection.sendRawTransaction(signed, {
    skipPreflight: false,
    maxRetries: 3,
  });
  const started = Date.now();
  while (Date.now() - started < 45000) {
    const status = (await connection.getSignatureStatuses([signature])).value[0];
    if (status?.err) throw new Error(`Local transaction failed: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
      process.stdout.write(JSON.stringify({ signature, slot: status.slot }));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Local transaction confirmation timed out');
}

module.exports = { walletRewardMessageAllowed };
if (require.main === module)
  main().catch((error) => {
    process.stderr.write(String(error.stack ?? error) + '\n');
    if (error.logs) process.stderr.write(JSON.stringify(error.logs) + '\n');
    process.exitCode = 1;
  });
