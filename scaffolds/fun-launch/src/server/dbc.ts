// Server-only helpers that read our coins straight from the DBC program.
// Import from API routes only: this module uses RPC_URL, which must not reach the browser.
import { Connection, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  unpackMint,
  type Mint,
} from '@solana/spl-token';
import {
  DynamicBondingCurveClient,
  deriveMintMetadata,
  getPriceFromSqrtPrice,
  type PoolConfig,
  type VirtualPool,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import type { Coin } from '@/lib/coin';
import { OffchainMetadataCache } from './offchainMetadata';
import { metadataStoreFromEnvironment } from './offchainMetadataStore';
import {
  discoverableConfigKeys,
  expectedGenesis,
  verifiedGenesis,
  verifyConfigAccount,
  verifyLaunchConfig,
} from './launchConfig';
import { isFeeModeId, isHsolMode, QUOTES, quoteAsset } from '@/lib/feeModes';
import { NETWORK_GENESIS } from '../../../../scripts/network-policy.cjs';
import { createHsolRateReader } from './hsolRate';
import {
  registeredConfigKeys,
  registeredCoin,
  registeredCoins,
  type LaunchMode,
  type RegisteredCoin,
} from './launchRegistry';
import { loadMigratedPool, migratedPrice, migratedQuoteReserve } from './damm';
import { hasSocials, SOCIAL_KINDS, type Socials } from '@/lib/socials';
import { allowsMskdIdentity } from './officialMskd';
import { readBorshString } from './mintMetadata';
import { createDisplayPoolReader } from './displayPools';
import { recordRpcUsage } from './rpcUsage';

const RPC_URL = process.env.RPC_URL as string;
const POOL_CONFIG_KEY = process.env.POOL_CONFIG_KEY as string;

/**
 * Reads go to RPC_URL. When it fails or rate-limits and RPC_FALLBACK_URL is set, the same
 * request is retried once against the fallback provider. Sent transactions are never retried here:
 * a timeout does not prove the first provider dropped them.
 */
export async function rpcFetch(input: Parameters<typeof fetch>[0], init?: RequestInit) {
  recordRpcUsage('web', init?.body);
  const fallback = process.env.RPC_FALLBACK_URL;
  const send = (url: Parameters<typeof fetch>[0]) =>
    fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
  const retryable = !fallback || !/"method":"sendTransaction"/.test(String(init?.body ?? ''));
  try {
    const response = await send(input);
    if (!fallback || !retryable || (response.status !== 429 && response.status < 500))
      return response;
  } catch (error) {
    if (!fallback || !retryable) throw error;
  }
  recordRpcUsage('fallback', init?.body);
  return send(fallback);
}

export const connection = new Connection(RPC_URL || 'http://127.0.0.1:8899', {
  commitment: 'confirmed',
  disableRetryOnRateLimit: true,
  fetch: rpcFetch,
});
export const dbc = new DynamicBondingCurveClient(connection, 'confirmed');
export const configKey = () => new PublicKey(POOL_CONFIG_KEY);
const hsolRate = createHsolRateReader(connection);
const displayPools = createDisplayPoolReader(connection, dbc.state);

const LAMPORTS = 1e9;
const COINS_TTL_MS = 10_000;

const configCache = new Map<string, { at: number; value: PoolConfig; digest: string }>();
let chainCache: { at: number; genesis: string; key: string } | undefined;
export async function networkGenesis(fresh = false): Promise<string> {
  const key = `${expectedGenesis()}:${process.env.RPC_URL ?? ''}`;
  if (!fresh && chainCache?.key === key && Date.now() - chainCache.at < 60_000)
    return chainCache.genesis;
  const genesis = await verifiedGenesis(connection);
  chainCache = { at: Date.now(), genesis, key };
  return genesis;
}
export async function getConfig(key: PublicKey = configKey(), fresh = false): Promise<PoolConfig> {
  const genesis = await networkGenesis(),
    id = `${genesis}:${key.toBase58()}`;
  const cached = configCache.get(id);
  if (!fresh && cached && Date.now() - cached.at < 60_000) return cached.value;
  const digest = await verifyConfigAccount(connection, key);
  const value = await dbc.state.getPoolConfig(key);
  if (
    !value ||
    (!value.quoteMint.equals(NATIVE_MINT) &&
      (genesis !== NETWORK_GENESIS['mainnet-beta'] ||
        value.quoteMint.toBase58() !== QUOTES.hsol.mint))
  )
    throw new Error('Unsupported pool quote mint');
  if (configCache.size >= 128) configCache.delete(configCache.keys().next().value!);
  configCache.set(id, { at: Date.now(), value, digest });
  return value;
}
export async function getLaunchConfig(mode: LaunchMode = 'bond') {
  const genesis = await networkGenesis(true);
  let key: PublicKey;
  if (isFeeModeId(mode)) {
    const keys = await registeredConfigKeys(genesis, `${mode}-v1`, true);
    if (keys.length !== 1)
      throw new Error('A single enabled reviewed config is required for this mode');
    key = new PublicKey(keys[0]!);
  } else key = configKey();
  const config = await getConfig(key, true);
  const cached = configCache.get(`${genesis}:${key.toBase58()}`);
  if (!cached) throw new Error('Configuration verification failed');
  const record = await verifyLaunchConfig(genesis, key, config, cached.digest, mode);
  if ((await networkGenesis(true)) !== genesis)
    throw new Error('Launch configuration network changed');
  return { genesis, key, config, record };
}
export async function supportedConfig(key: PublicKey) {
  return (await discoverableConfigKeys(await networkGenesis())).includes(key.toBase58());
}

const socialsOf = (meta: Socials): Socials | undefined => {
  const links = Object.fromEntries(
    SOCIAL_KINDS.flatMap((kind) => (meta[kind] ? [[kind, meta[kind]]] : []))
  ) as Socials;
  return hasSocials(links) ? links : undefined;
};

export type TokenMeta = {
  name: string;
  symbol: string;
  image: string | null;
  /** Source post on X, as recorded in the metadata JSON at launch */
  source: string | null;
  description?: string;
} & Socials;
// On-chain identity stays separate from the durable, untrusted image/source cache.
const metaCache = new Map<string, TokenMeta>();
const metaUris = new Map<string, string>();
const offchainMetadata = new OffchainMetadataCache({ store: metadataStoreFromEnvironment() });
export const cacheUploadedMetadata = (uri: string, metadata: unknown) =>
  offchainMetadata.seed(uri, metadata);

async function getMetas(mints: PublicKey[]): Promise<Map<string, TokenMeta>> {
  const missing = mints.filter((m) => !metaCache.has(m.toBase58()));
  // Solana accepts at most 100 accounts per call. Keep off-chain downloads bounded too.
  for (let start = 0; start < missing.length; start += 24) {
    const batch = missing.slice(start, start + 24);
    const accounts = await connection.getMultipleAccountsInfo(batch.map(deriveMintMetadata));
    await Promise.all(
      batch.map(async (mint, i) => {
        const data = accounts[i]?.data;
        if (!data) return;
        // Metaplex layout: key(1) update_authority(32) mint(32) name symbol uri
        try {
          const [name, afterName] = readBorshString(data, 65);
          const [symbol, afterSymbol] = readBorshString(data, afterName);
          const [uri] = readBorshString(data, afterSymbol);
          if (metaCache.size >= 5000) {
            const oldest = metaCache.keys().next().value!;
            metaCache.delete(oldest);
            metaUris.delete(oldest);
          }
          metaUris.set(mint.toBase58(), uri);
          metaCache.set(mint.toBase58(), { name, symbol, image: null, source: null });
        } catch {
          // One malformed token must not take the board offline.
        }
      })
    );
  }
  const pending = Promise.all(
    mints.map(async (mint) => {
      const key = mint.toBase58();
      const uri = metaUris.get(key);
      const meta = metaCache.get(key);
      if (!uri || !meta) return;
      const offchain = await offchainMetadata.get(uri);
      if (metaUris.get(key) === uri) metaCache.set(key, { ...meta, ...offchain });
    })
  );
  // A slow gateway must not hold the entire board offline. Downloads finish in the background.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      pending,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  return metaCache;
}

async function toCoin(
  address: PublicKey,
  account: VirtualPool,
  config: PoolConfig,
  mintData: Mint,
  registry: RegisteredCoin | null | undefined,
  meta?: TokenMeta
): Promise<Coin | null> {
  const s = account.poolState;
  const mint = s.baseMint.toBase58();
  const name = meta?.name || 'Unnamed coin';
  const symbol = meta?.symbol || mint.slice(0, 4);
  if (!allowsMskdIdentity({ name, symbol, mint, deployer: registry?.original_deployer }))
    return null;
  const asset = quoteAsset(config.quoteMint.toBase58());
  if (
    asset.symbol === 'hSOL' &&
    (!registry || !isHsolMode(registry.mode) || registry.quote_mint !== asset.mint)
  )
    return null;
  const quoteToSol = asset.symbol === 'hSOL' ? await hsolRate().catch((): null => null) : 1;
  if (quoteToSol === null) return null;
  const quoteReserveSol = (Number(s.quoteReserve.toString()) * quoteToSol) / LAMPORTS;
  const thresholdSol = (Number(config.migrationQuoteThreshold.toString()) * quoteToSol) / LAMPORTS;
  let priceSol = Number(
    getPriceFromSqrtPrice(s.sqrtPrice as BN, mintData.decimals, asset.decimals).toString()
  );
  const isMigrated = Number(s.isMigrated) === 1;
  let migratedPool: string | undefined;
  let migratedQuoteReserveSol: number | undefined;
  let migratedBaseIsA: boolean | undefined;
  if (isMigrated) {
    const migrated = await loadMigratedPool(connection, config, s.baseMint);
    priceSol = migratedPrice(migrated.state, s.baseMint, mintData.decimals, config.quoteMint);
    migratedPool = migrated.address.toBase58();
    const reserve = migratedQuoteReserve(migrated.state, config.quoteMint);
    if (reserve !== undefined) migratedQuoteReserveSol = reserve * quoteToSol;
    migratedBaseIsA = migrated.state.tokenAMint.equals(s.baseMint);
  }
  priceSol *= quoteToSol;
  const supply = Number(mintData.supply) / 10 ** mintData.decimals;
  return {
    mint,
    pool: address.toBase58(),
    creator: registry?.original_deployer ?? s.creator.toBase58(),
    originalDeployer: registry?.original_deployer,
    mode: registry?.mode,
    configKey: s.config.toBase58(),
    feePolicyVersion: registry?.policy_version,
    creatorShareBps: registry?.creator_share_bps ?? null,
    quoteMint: config.quoteMint.toBase58(),
    quoteToSol,
    tokenDecimals: mintData.decimals,
    tokenSupply: supply,
    migratedPool,
    migratedQuoteReserveSol,
    migratedBaseIsA,
    dbcCollectFeeMode: config.collectFeeMode,
    name,
    symbol,
    image: meta?.image ?? null,
    description: meta?.description,
    socials: meta ? socialsOf(meta) : undefined,
    source: meta?.source ?? undefined,
    launchedAt:
      config.activationType === 0
        ? Number(
            registry?.activation_time ??
              (await connection.getBlockTime(Number(s.activationPoint.toString()))) ??
              0
          )
        : Number(s.activationPoint.toString()),
    launchSlot: config.activationType === 0 ? Number(s.activationPoint.toString()) : undefined,
    quoteReserveSol,
    thresholdSol,
    progress: Math.min(quoteReserveSol / thresholdSol, 1),
    isMigrated,
    priceSol,
    marketCapSol: priceSol * supply,
    launchPriceSol:
      Number(
        getPriceFromSqrtPrice(
          config.sqrtStartPrice as BN,
          mintData.decimals,
          asset.decimals
        ).toString()
      ) * quoteToSol,
  };
}

let coinsCache: { at: number; coins: Coin[] } | null = null;
let coinsPending: Promise<Coin[]> | null = null;
let coinsGeneration = 0;
type CoinLookup = { coin: Coin; account: VirtualPool; config: PoolConfig };
const coinLookups = new Map<
  string,
  { at: number; value: CoinLookup | null; generation: number; pending?: Promise<CoinLookup | null> }
>();
export function invalidateCoinDisplay(mint: string) {
  for (const [key, entry] of coinLookups)
    if (key.endsWith(':' + mint)) {
      entry.at = 0;
      entry.generation++;
    }
}

export function invalidateCoinDiscovery(mint: string) {
  invalidateCoinDisplay(mint);
  displayPools.invalidate();
  coinsGeneration++;
  coinsCache = null;
}

/** Every coin read again from chain now, for the display indexer. */
export async function freshCoins(): Promise<Coin[]> {
  coinsGeneration++;
  coinsCache = null;
  return listCoins();
}

/** One coin's display state read again from chain now, for the display indexer. */
export async function freshCoin(mint: string): Promise<Coin | null> {
  invalidateCoinDisplay(mint);
  return (await getCoin(mint, { fresh: false }))?.coin ?? null;
}

/** All pools on our config, newest first. */
export async function listCoins(): Promise<Coin[]> {
  if (coinsCache && Date.now() - coinsCache.at < COINS_TTL_MS) return coinsCache.coins;
  if (coinsPending) return coinsPending;
  coinsPending = loadCoins();
  try {
    return await coinsPending;
  } finally {
    coinsPending = null;
  }
}

async function loadCoins(): Promise<Coin[]> {
  const generation = coinsGeneration;
  const genesis = await networkGenesis();
  const keys = (await discoverableConfigKeys(genesis)).map((key) => new PublicKey(key));
  const configs = new Map(
    await Promise.all(keys.map(async (key) => [key.toBase58(), await getConfig(key)] as const))
  );
  const all = await displayPools.list(keys);
  const mints = all.map((p) => p.account.poolState.baseMint);
  const [metas, registry] = await Promise.all([
    getMetas(mints),
    registeredCoins(
      genesis,
      mints.map((mint) => mint.toBase58())
    ),
  ]);
  const coins: Coin[] = [];
  // Fresh mint supplies deliberately bypass immutable metadata caches so burns update market caps.
  for (let i = 0; i < all.length; i += 24) {
    const batch = all.slice(i, i + 24),
      mintAccounts = await connection.getMultipleAccountsInfo(
        batch.map((p) => p.account.poolState.baseMint)
      );
    await Promise.all(
      batch.map(async (p, index) => {
        const info = mintAccounts[index],
          mint = p.account.poolState.baseMint,
          config = configs.get(p.account.poolState.config.toBase58());
        if (
          !config ||
          !info ||
          (!info.owner.equals(TOKEN_PROGRAM_ID) && !info.owner.equals(TOKEN_2022_PROGRAM_ID))
        )
          return;
        const data = unpackMint(mint, info, info.owner);
        const coin = await toCoin(
          p.publicKey,
          p.account,
          config,
          data,
          registry.get(mint.toBase58()),
          metas.get(mint.toBase58())
        );
        if (coin) coins.push(coin);
      })
    );
  }
  coins.sort((a, b) => b.launchedAt - a.launchedAt);
  if (generation === coinsGeneration) coinsCache = { at: Date.now(), coins };
  return coins;
}

/** One coin by mint, fresh from chain (not cached). */
export async function getCoin(
  mint: string,
  { fresh = true }: { fresh?: boolean } = {}
): Promise<{ coin: Coin; account: VirtualPool; config: PoolConfig } | null> {
  const genesis = await networkGenesis();
  const cacheKey = `${genesis}:${mint}`;
  // Trading/validation callers retain fresh reads by default; only display endpoints opt into caching.
  if (fresh) return loadCoin(mint, genesis);
  const current = coinLookups.get(cacheKey);
  if (current && Date.now() - current.at < (current.value ? 3000 : 15_000)) return current.value;
  if (current?.pending) return current.pending;
  if (coinLookups.size >= 256) {
    const oldest = [...coinLookups].find(([, entry]) => !entry.pending)?.[0];
    if (oldest) coinLookups.delete(oldest);
    else throw new Error('Coin display cache is busy');
  }
  const entry = current ?? { at: 0, value: null, generation: 0 },
    generation = entry.generation,
    pending = loadCoin(mint, genesis);
  entry.pending = pending;
  coinLookups.set(cacheKey, entry);
  try {
    const value = await pending;
    entry.value = value;
    entry.at = entry.generation === generation ? Date.now() : 0;
    return value;
  } catch (error) {
    coinLookups.delete(cacheKey);
    throw error;
  } finally {
    delete entry.pending;
  }
}
async function loadCoin(mint: string, genesis: string): Promise<CoinLookup | null> {
  const mintKey = new PublicKey(mint);
  const registry = await registeredCoin(genesis, mint);
  const registered = registry
    ? await displayPools.read({
        publicKey: new PublicKey(registry.dbc_pool),
        mint: mintKey,
        config: new PublicKey(registry.config_key),
      })
    : null;
  const found = registry ? registered : await dbc.state.getPoolByBaseMint(mintKey);
  if (!found) return null;
  const s = found.account.poolState;
  if (!(await supportedConfig(s.config))) return null;
  const [config, metas, info] = await Promise.all([
    getConfig(s.config),
    getMetas([s.baseMint]),
    registered ? registered.mintInfo : connection.getAccountInfo(s.baseMint),
  ]);
  if (!info || (!info.owner.equals(TOKEN_PROGRAM_ID) && !info.owner.equals(TOKEN_2022_PROGRAM_ID)))
    return null;
  const mintData = unpackMint(s.baseMint, info, info.owner);
  const coin = await toCoin(
    found.publicKey,
    found.account,
    config,
    mintData,
    registry,
    metas.get(mint)
  );
  return coin ? { coin, account: found.account, config } : null;
}

/** Parses a base58 address from user input, or null if it is not one. */
export function parseKey(value: unknown): PublicKey | null {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44) return null;
  try {
    return new PublicKey(value);
  } catch {
    return null;
  }
}

/** Current on-chain time, used as the fee scheduler's clock. */
export async function chainTime(): Promise<number> {
  const slot = await connection.getSlot('confirmed');
  const time = await connection.getBlockTime(slot);
  if (time === null) throw new Error('On-chain clock is unavailable');
  return time;
}
