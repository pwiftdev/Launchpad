/* Read-only, public endpoints only. No wallet, keypair, application env or transaction signing. */
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const dependencyRoot = fs.existsSync(path.join(__dirname, 'node_modules/@solana/web3.js'))
  ? path.join(__dirname, 'package.json')
  : path.resolve(__dirname, '../scaffolds/fun-launch/package.json');
const { Connection, PublicKey } = createRequire(dependencyRoot)('@solana/web3.js');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const ids = {
  dbc: 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN',
  damm: 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG',
  metadata: 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
};

function elfBytes(file) {
  if (!file.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) || file[4] !== 2 || file[5] !== 1)
    throw new Error('Expected little-endian ELF64');
  const offset = at => {
    const value = file.readBigUInt64LE(at);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('ELF offset exceeds capacity');
    return Number(value);
  };
  const ph = offset(32), sh = offset(40), phSize = file.readUInt16LE(54), phCount = file.readUInt16LE(56),
    shSize = file.readUInt16LE(58), shCount = file.readUInt16LE(60);
  if ((phCount && phSize < 56) || (shCount && shSize < 64)) throw new Error('Unsupported ELF tables');
  let end = Math.max(file.readUInt16LE(52), ph + phSize * phCount, sh + shSize * shCount);
  if (end > file.length || (sh && !shCount)) throw new Error('Invalid or extended ELF table bounds');
  for (let n = 0; n < phCount; n++) end = Math.max(end, offset(ph + n * phSize + 8) + offset(ph + n * phSize + 32));
  for (let n = 0; n < shCount; n++) {
    const entry = sh + n * shSize;
    if (file.readUInt32LE(entry + 4) !== 8) end = Math.max(end, offset(entry + 24) + offset(entry + 32));
  }
  if (end > file.length || file.subarray(end).some(byte => byte !== 0)) throw new Error('Unexpected bytes outside the ELF file');
  return file.subarray(0, end);
}

async function compare(directory) {
  const networks = {
    mainnet: ['https://api.mainnet-beta.solana.com', '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'],
    devnet: ['https://api.devnet.solana.com', 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'],
  };
  const result = { checkedAt: new Date().toISOString(), readOnly: true, programs: {} };
  const loader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
  for (const [network, [url, genesis]] of Object.entries(networks)) {
    const rpc = new Connection(url, { commitment: 'finalized', disableRetryOnRateLimit: true,
      fetch: (input, options) => fetch(input, { ...options, signal: AbortSignal.timeout(20000) }) });
    if (await rpc.getGenesisHash() !== genesis) throw new Error('Public network genesis mismatch');
    for (const [label, address] of Object.entries(ids)) {
      const program = await rpc.getAccountInfo(new PublicKey(address), 'finalized');
      if (!program?.executable || !program.owner.equals(loader) || program.data.readUInt32LE(0) !== 2)
        throw new Error('Unexpected program loader state');
      const dataAddress = new PublicKey(program.data.subarray(4, 36));
      const response = await rpc.getAccountInfoAndContext(dataAddress, 'finalized'), account = response.value;
      if (!account?.owner.equals(loader) || account.data.readUInt32LE(0) !== 3) throw new Error('Unexpected ProgramData state');
      const deployed = account.data.subarray(45), file = fs.readFileSync(path.join(directory, `${network === 'mainnet' ? 'mainnet-' : ''}${label}.so`));
      if (!deployed.equals(file)) throw new Error('Program changed or dump padding differs; refresh the public dump');
      const active = elfBytes(file);
      result.programs[label] ??= { address };
      result.programs[label][network] = {
        genesis, finalizedReadSlot: response.context.slot, programDataAddress: dataAddress.toBase58(),
        lastUpgradeSlot: account.data.readBigUInt64LE(4).toString(),
        upgradeAuthority: account.data[12] === 1 ? new PublicKey(account.data.subarray(13, 45)).toBase58() : null,
        dumpSha256: sha(file), dumpBytes: file.length, elfSha256: sha(active), elfBytes: active.length,
      };
    }
  }
  for (const program of Object.values(result.programs)) {
    program.dumpIdentical = program.mainnet.dumpSha256 === program.devnet.dumpSha256;
    program.elfIdentical = program.mainnet.elfSha256 === program.devnet.elfSha256;
  }
  return result;
}

module.exports = { compare, elfBytes };
if (require.main === module) compare(path.resolve(process.argv[2] || '.local/programs')).then(result => {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}).catch(error => { console.error(error.message); process.exitCode = 1; });
