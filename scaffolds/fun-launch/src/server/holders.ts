import { PublicKey, SystemProgram, type Connection } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  unpackAccount,
  unpackMint,
} from '@solana/spl-token';
import type { HoldersResponse } from '@/lib/coin';
type HolderRpc = Pick<Connection, 'getTokenLargestAccounts' | 'getMultipleAccountsInfoAndContext'>;
/** Display sample only. Every numerator and supply denominator comes from one confirmed bank. */
export async function readHolders(
  rpc: HolderRpc,
  input: { mint: PublicKey; creator: string; excludedAccounts: PublicKey[] }
): Promise<HoldersResponse> {
  const largest = await rpc.getTokenLargestAccounts(input.mint, 'confirmed'),
    excluded = new Set(input.excludedAccounts.map((key) => key.toBase58())),
    addresses = [
      input.mint,
      ...input.excludedAccounts,
      ...largest.value.map((row) => row.address),
    ].filter((key, index, all) => all.findIndex((k) => k.equals(key)) === index);
  if (addresses.length > 100) throw new Error('Holder sample exceeds RPC account capacity');
  const snapshot = await rpc.getMultipleAccountsInfoAndContext(addresses, {
    commitment: 'confirmed',
    minContextSlot: largest.context.slot,
  });
  if (
    !Number.isSafeInteger(snapshot.context.slot) ||
    snapshot.context.slot < largest.context.slot ||
    snapshot.value.length !== addresses.length
  )
    throw new Error('Holder account bank is incomplete');
  const infos = new Map(addresses.map((key, i) => [key.toBase58(), snapshot.value[i]])),
    mintInfo = infos.get(input.mint.toBase58());
  if (
    !mintInfo ||
    (!mintInfo.owner.equals(TOKEN_PROGRAM_ID) && !mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID))
  )
    throw new Error('Current mint account unavailable');
  const mint = unpackMint(input.mint, mintInfo, mintInfo.owner),
    scale = 10 ** mint.decimals;
  const read = (key: PublicKey) => {
    const info = infos.get(key.toBase58());
    if (!info || (info.owner.equals(SystemProgram.programId) && !info.data.length)) return null;
    if (!info.owner.equals(TOKEN_PROGRAM_ID) && !info.owner.equals(TOKEN_2022_PROGRAM_ID))
      throw new Error('Invalid holder token account');
    const account = unpackAccount(key, info, info.owner);
    if (!account.mint.equals(input.mint) || !account.isInitialized)
      throw new Error('Holder token identity differs');
    return account;
  };
  let excludedRaw = 0n;
  for (const key of new Map(input.excludedAccounts.map((key) => [key.toBase58(), key])).values())
    excludedRaw += read(key)?.amount ?? 0n;
  if (excludedRaw > mint.supply) throw new Error('Custody exceeds current mint supply');
  const circulatingRaw = mint.supply - excludedRaw,
    owners = new Map<string, bigint>();
  const seen = new Set<string>();
  for (const row of largest.value) {
    const address = row.address.toBase58();
    if (excluded.has(address) || seen.has(address)) continue;
    seen.add(address);
    const account = read(row.address);
    if (!account || account.amount === 0n) continue;
    const owner = account.owner.toBase58();
    owners.set(owner, (owners.get(owner) ?? 0n) + account.amount);
  }
  const holders = [...owners]
    .sort((a, b) => (a[1] === b[1] ? a[0].localeCompare(b[0]) : a[1] > b[1] ? -1 : 1))
    .map(([owner, raw]) => {
      if (raw > circulatingRaw) throw new Error('Holder sample exceeds circulation');
      return {
        owner,
        amount: Number(raw) / scale,
        shareOfCirculating: circulatingRaw ? Number(raw) / Number(circulatingRaw) : 0,
        shareOfSupply: mint.supply ? Number(raw) / Number(mint.supply) : 0,
        isCreator: owner === input.creator,
      };
    });
  return {
    holders,
    circulating: Number(circulatingRaw) / scale,
    tokenSupply: Number(mint.supply) / scale,
    excludedSupply: Number(excludedRaw) / scale,
    scope: 'largest-token-accounts',
    sampledAccounts: largest.value.length,
    partial: true,
    snapshotSlot: snapshot.context.slot,
    updatedAt: Math.floor(Date.now() / 1000),
    stale: false,
  };
}
const cache = new Map<
  string,
  {
    at: number;
    value?: HoldersResponse;
    pending?: Promise<HoldersResponse>;
    retryAt: number;
  }
>();
export async function cachedHolders(
  mint: string,
  load: () => Promise<HoldersResponse>
): Promise<HoldersResponse> {
  const entry = cache.get(mint),
    now = Date.now();
  if (entry?.value && (now - entry.at < 15_000 || now < entry.retryAt))
    return { ...entry.value, stale: now < entry.retryAt };
  if (entry?.pending) return entry.pending;
  if (!entry && cache.size >= 128) {
    const idle = [...cache].find(([, e]) => !e.pending)?.[0];
    if (!idle) throw new Error('Holders display service busy');
    cache.delete(idle);
  }
  const next = entry ?? { at: 0, retryAt: 0 };
  const pending = load()
    .then((value) => {
      next.value = value;
      next.at = Date.now();
      next.retryAt = 0;
      return value;
    })
    .catch((error) => {
      next.retryAt = Date.now() + 3000;
      if (next.value) return { ...next.value, stale: true };
      throw error;
    })
    .finally(() => {
      delete next.pending;
    });
  next.pending = pending;
  cache.set(mint, next);
  return pending;
}
