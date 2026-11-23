const NETWORK_GENESIS = {
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
};
const PUBLIC_CLUSTER_GENESIS = new Set([
  ...Object.values(NETWORK_GENESIS),
  '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY', // Solana testnet, never an isolated fixture.
]);
const loopback = (value) => {
  try {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
};
function localValidatorPolicy(env = process.env) {
  const enabled = env.LOCAL_VALIDATOR_ENABLED === 'true';
  if (
    env.NODE_ENV === 'production' &&
    (enabled || env.LOCAL_VALIDATOR_GENESIS_HASH || env.NEXT_PUBLIC_LOCAL_VALIDATOR_RPC_URL)
  )
    throw new Error('Local validator configuration cannot be shipped to production');
  if (!enabled) {
    if (env.NEXT_PUBLIC_NETWORK === 'localnet')
      throw new Error('Localnet requires explicit isolated validator configuration');
    return false;
  }
  if (env.NODE_ENV === 'production' || env.NEXT_PUBLIC_NETWORK !== 'localnet')
    throw new Error('Local validator mode is development-only');
  const pinned = env.LOCAL_VALIDATOR_GENESIS_HASH;
  if (
    !pinned ||
    !/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(pinned) ||
    PUBLIC_CLUSTER_GENESIS.has(pinned)
  )
    throw new Error('Independently pinned local validator genesis is required');
  if (!loopback(env.RPC_URL) || !loopback(env.NEXT_PUBLIC_SITE_URL))
    throw new Error('Local validator RPC and site must use loopback URLs');
  const aliases = (env.SITE_ALLOWED_ORIGINS || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  if (aliases.some((value) => !loopback(value)))
    throw new Error('Local validator aliases must stay on loopback');
  if (
    env.NEXT_PUBLIC_LOCAL_VALIDATOR_RPC_URL &&
    (!loopback(env.NEXT_PUBLIC_LOCAL_VALIDATOR_RPC_URL) ||
      new URL(env.NEXT_PUBLIC_LOCAL_VALIDATOR_RPC_URL).origin !== new URL(env.RPC_URL).origin)
  )
    throw new Error('Public local validator endpoint must match the local RPC origin');
  return true;
}
function expectedNetworkGenesis(env = process.env) {
  if (localValidatorPolicy(env)) return env.LOCAL_VALIDATOR_GENESIS_HASH;
  const network = env.NEXT_PUBLIC_NETWORK || 'devnet';
  if (!Object.hasOwn(NETWORK_GENESIS, network)) throw new Error('Unrecognized network');
  return NETWORK_GENESIS[network];
}
module.exports = {
  NETWORK_GENESIS,
  isLoopbackOrigin: loopback,
  localValidatorPolicy,
  expectedNetworkGenesis,
};
