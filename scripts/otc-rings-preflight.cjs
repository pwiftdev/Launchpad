const { createRequire } = require('node:module');
const { NETWORK_GENESIS } = require('./network-policy.cjs');

const appRequire = createRequire(require.resolve('../scaffolds/fun-launch/package.json'));
const { Connection, PublicKey, SystemProgram } = appRequire('@solana/web3.js');
const { TOKEN_PROGRAM_ID, unpackAccount } = appRequire('@solana/spl-token');

const privacyProgram = new PublicKey('ring1GaLCuJnkUMVkX2JeZLTTX17wKsV4fZmPVzXANW');
const loader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const usdcMint = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const requirements = [
  ['Privacy program', privacyProgram, loader, true],
  ['User registry', new PublicKey('regy3WAeRXMYuMYxr5iK3Bf9Arr3PcxGxyzAddbiqDQ'), loader, true],
  [
    'State tree',
    new PublicKey('777pvSGe5LaBd9nCczvE2FXEauiwtfGJ5XRpjKyniGor'),
    privacyProgram,
    false,
  ],
  [
    'SOL interface',
    new PublicKey('CiNmas621VuyofiDSrEPfTXHKrdZuB6jMKECyNiMpLXE'),
    SystemProgram.programId,
    false,
  ],
  [
    'USDC interface',
    new PublicKey('H4RD4XSWp8TLmrNYCLmV74a5ixude5s9gGqpCFjXkBLQ'),
    TOKEN_PROGRAM_ID,
    false,
    isUsdcAccount,
  ],
];

function isUsdcAccount(address, account) {
  try {
    const token = unpackAccount(address, account, TOKEN_PROGRAM_ID);
    return token.mint.equals(usdcMint) && token.isInitialized && !token.isFrozen;
  } catch {
    return false;
  }
}

async function checkMainnetRings(rpc) {
  const genesis = await rpc.getGenesisHash();
  const network = 'mainnet-beta';
  if (genesis !== NETWORK_GENESIS[network])
    return { ok: false, network, error: 'RPC_NETWORK_MISMATCH' };

  const snapshot = await rpc.getMultipleAccountsInfoAndContext(
    requirements.map(([, address]) => address),
    'finalized'
  );
  const accounts = requirements.map(([label, address, owner, executable, validate], index) => {
    const account = snapshot.value[index];
    const ok = Boolean(
      account &&
      account.owner.equals(owner) &&
      account.executable === executable &&
      (!validate || validate(address, account))
    );
    return { label, address: address.toBase58(), ok };
  });
  return {
    ok: accounts.every((account) => account.ok),
    network,
    finalizedSlot: snapshot.context.slot,
    accounts,
  };
}

async function main() {
  const rpc = new Connection(process.env.RPC_URL || 'https://api.mainnet-beta.solana.com', {
    disableRetryOnRateLimit: true,
    fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(10000) }),
  });
  const report = await checkMainnetRings(rpc);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

module.exports = { checkMainnetRings };
if (require.main === module)
  main().catch(() => {
    console.error('Could not read the Rings accounts from mainnet RPC.');
    process.exitCode = 1;
  });
