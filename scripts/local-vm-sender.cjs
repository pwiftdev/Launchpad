/* Local rehearsal only. Financial role keys remain inside the isolated VM. */
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawn } = require('node:child_process');
const workspace = path.resolve(__dirname, '..');
const appRequire = createRequire(path.join(workspace, 'scaffolds/fun-launch/package.json'));
const { Connection, PublicKey } = appRequire('@solana/web3.js');
const { NETWORK_GENESIS } = require('./network-policy.cjs');
const liveGenesis = new Set([...Object.values(NETWORK_GENESIS), '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY']);
const profiles = new Set(['devnet-binaries', 'mainnet-binaries']);

function assertLocalRpc(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port !== '8899' || url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error('Rehearsal RPC must be http://127.0.0.1:8899');
}

function sshRequest(payload) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '2222', '-i', path.join(workspace, '.local/toolchain/vm-ssh'), '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + path.join(workspace, '.local/toolchain/known_hosts'), '-o', 'LogLevel=ERROR', 'root@127.0.0.1', '/root/rinsed-rehearsal/toolchain/node/bin/node', '/root/rinsed-rehearsal/local-signer.cjs'];
    const child = spawn('ssh.exe', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', error = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { error += data; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`Local signer failed (${code}): ${error.slice(-12000)}`));
      try { resolve(JSON.parse(output)); } catch { reject(new Error('Invalid local signer response')); }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

async function createLocalSender({ fixturePath = path.join(workspace, '.local/mainnet-rehearsal-fixture.json') } = {}) {
  if (process.env.NODE_ENV === 'production') throw new Error('Local signer unavailable in production');
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8').replace(/^\uFEFF/, ''));
  if (!profiles.has(fixture.profile)) throw new Error('Unknown isolated signing profile');
  assertLocalRpc(fixture.rpcUrl);
  const connection = new Connection(fixture.rpcUrl, 'confirmed');
  const verify = async () => {
    if (!fixture.networkGenesis || liveGenesis.has(fixture.networkGenesis) || await connection.getGenesisHash() !== fixture.networkGenesis)
      throw new Error('Local validator genesis mismatch');
  };
  await verify();
  const roles = Object.fromEntries(Object.entries(fixture.roles).map(([name, key]) => [name, new PublicKey(key)]));
  async function request(transaction, { roles: requestedRoles = ['operator'], signers = [] } = {}, action = 'send') {
      await verify();
      if (!requestedRoles.length || requestedRoles.some((role) => !roles[role])) throw new Error('Unknown local signer role');
      transaction.feePayer ??= roles[requestedRoles[0]];
      if (!transaction.recentBlockhash) transaction.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
      if (signers.length) transaction.partialSign(...signers);
      const wire = transaction.serialize({ requireAllSignatures: false, verifySignatures: false });
      return sshRequest({ action, profile: fixture.profile, networkGenesis: fixture.networkGenesis, roles: requestedRoles, transaction: wire.toString('base64') });
  }
  return {
    connection, fixture, roles, programId: new PublicKey(fixture.programId),
    send: (transaction, options) => request(transaction, options, 'send'),
    sign: (transaction, options) => request(transaction, options, 'sign-only'),
    async signMessage(message, { role = 'claimant' } = {}) {
      await verify();
      if (!roles[role]) throw new Error('Unknown local signer role');
      return sshRequest({ action: 'sign-message', profile: fixture.profile, networkGenesis: fixture.networkGenesis, roles: [role], messageBase64: Buffer.from(message).toString('base64') });
    },
  };
}

module.exports = { createLocalSender, assertLocalRpc };
