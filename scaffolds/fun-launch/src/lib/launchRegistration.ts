import { PublicKey, type Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import type { LaunchPreparationContext } from './launchPreparation';
export type PendingLaunch = {
  mint: string;
  signature: string;
  wallet: string;
  name: string;
  symbol: string;
  image: string | null;
  devBuyPercent: number;
  mode: import('@/lib/launchModes').LaunchMode;
} & Partial<LaunchPreparationContext>;
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const LEGACY_KEY = 'rinsed.pendingLaunch.v1';
export const pendingLaunchKey = (wallet: string, genesis: string) =>
  `rinsed.pendingLaunch.v2:${genesis}:${wallet}`;
const pub = (value: unknown) => {
  try {
    return (
      typeof value === 'string' &&
      value.length >= 32 &&
      value.length <= 44 &&
      new PublicKey(value).toBase58() === value
    );
  } catch {
    return false;
  }
};
function context(value: Record<string, unknown>): LaunchPreparationContext {
  if (
    !pub(value.genesis) ||
    !pub(value.blockhash) ||
    !Number.isSafeInteger(value.preparedSlot) ||
    Number(value.preparedSlot) < 0 ||
    !Number.isSafeInteger(value.lastValidBlockHeight) ||
    Number(value.lastValidBlockHeight) < 0 ||
    typeof value.messageDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.messageDigest) ||
    typeof value.messageBase64 !== 'string' ||
    value.messageBase64.length > 1644 ||
    typeof value.preparationProof !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.preparationProof)
  )
    throw new Error('Complete launch recovery context is required');
  return {
    genesis: value.genesis as string,
    blockhash: value.blockhash as string,
    preparedSlot: Number(value.preparedSlot),
    lastValidBlockHeight: Number(value.lastValidBlockHeight),
    messageDigest: value.messageDigest,
    messageBase64: value.messageBase64,
    preparationProof: value.preparationProof,
  };
}
function parse(raw: string | null, wallet: string): PendingLaunch | null {
  try {
    if (raw && raw.length > 12000) return null;
    const row = JSON.parse(raw ?? 'null') as Record<string, unknown>;
    if (
      !row ||
      row.wallet !== wallet ||
      !pub(row.wallet) ||
      !pub(row.mint) ||
      typeof row.signature !== 'string' ||
      row.signature.length < 64 ||
      row.signature.length > 88 ||
      bs58.decode(row.signature).length !== 64 ||
      !['bond', 'creator', 'community', 'mskd', 'dev', 'cashback'].includes(String(row.mode)) ||
      typeof row.name !== 'string' ||
      row.name.length > 64 ||
      typeof row.symbol !== 'string' ||
      row.symbol.length > 16 ||
      typeof row.devBuyPercent !== 'number' ||
      !Number.isFinite(row.devBuyPercent) ||
      row.devBuyPercent < 0 ||
      row.devBuyPercent > 2 ||
      (row.image !== null &&
        (typeof row.image !== 'string' ||
          row.image.length > 2048 ||
          !/^https:\/\//.test(row.image)))
    )
      return null;
    const receipt = {
      mint: row.mint as string,
      signature: row.signature,
      wallet,
      name: row.name,
      symbol: row.symbol,
      image: row.image as string | null,
      devBuyPercent: row.devBuyPercent,
      mode: row.mode as PendingLaunch['mode'],
      ...(pub(row.genesis) ? { genesis: row.genesis as string } : {}),
    };
    // Legacy receipts stay recoverable but cannot authorize an expiry-based clear.
    try {
      return { ...receipt, ...context(row) };
    } catch {
      return receipt;
    }
  } catch {
    return null;
  }
}
export function pendingLaunchFor(
  wallet: string,
  genesis?: string,
  storage?: StorageLike
): PendingLaunch | null {
  try {
    const target = storage ?? globalThis.localStorage,
      legacy = parse(target.getItem(LEGACY_KEY), wallet);
    return (
      (genesis ? parse(target.getItem(pendingLaunchKey(wallet, genesis)), wallet) : null) ??
      (legacy && (!genesis || !legacy.genesis || legacy.genesis === genesis) ? legacy : null)
    );
  } catch {
    return null;
  }
}
/** Public message + receipt only. No mint/wallet signatures beyond the public transaction ID. */
export function savePendingLaunch(
  receipt: PendingLaunch & LaunchPreparationContext,
  storage?: StorageLike
): void {
  let target: StorageLike;
  try {
    target = storage ?? globalThis.localStorage;
  } catch {
    throw new Error(
      'Could not save your launch receipt. No transaction was submitted. Enable browser storage before retrying.'
    );
  }
  const prepared = context(receipt as unknown as Record<string, unknown>),
    clean = parse(JSON.stringify(receipt), receipt.wallet);
  if (!clean) throw new Error('Invalid public launch receipt');
  const scoped = target.getItem(pendingLaunchKey(receipt.wallet, prepared.genesis));
  if (scoped && !parse(scoped, receipt.wallet))
    throw new Error('The saved launch receipt needs review before another launch');
  const previous = pendingLaunchFor(receipt.wallet, prepared.genesis, target);
  if (previous && (previous.mint !== receipt.mint || previous.signature !== receipt.signature))
    throw new Error('Finish checking your saved launch before preparing another');
  const serialized = JSON.stringify({ ...clean, ...prepared, version: 2 });
  try {
    target.setItem(pendingLaunchKey(receipt.wallet, prepared.genesis), serialized);
    if (target.getItem(pendingLaunchKey(receipt.wallet, prepared.genesis)) !== serialized)
      throw new Error();
  } catch {
    throw new Error(
      'Could not save your launch receipt. No transaction was submitted. Enable browser storage before retrying.'
    );
  }
}
export function clearPendingLaunch(
  mint: string,
  wallet?: string,
  genesis?: string,
  storage?: StorageLike
): void {
  const target = storage ?? globalThis.localStorage;
  for (const key of [
    LEGACY_KEY,
    ...(wallet && genesis ? [pendingLaunchKey(wallet, genesis)] : []),
  ]) {
    const raw = target.getItem(key);
    let row: Record<string, unknown> | null;
    try {
      row = JSON.parse(raw ?? 'null');
    } catch {
      continue;
    }
    if (
      row?.mint === mint &&
      (!wallet || row.wallet === wallet) &&
      (!genesis || !row.genesis || row.genesis === genesis)
    ) {
      target.removeItem(key);
      if (target.getItem(key) !== null) throw new Error('Could not clear the saved receipt');
    }
  }
}
export function preparedLaunchMessage(
  transaction: Transaction,
  value: unknown,
  expectedGenesis: string
): { message: Uint8Array; context: LaunchPreparationContext } {
  const prepared = context(value as Record<string, unknown>),
    message = transaction.serializeMessage();
  if (
    prepared.genesis !== expectedGenesis ||
    transaction.recentBlockhash !== prepared.blockhash ||
    message.toString('base64') !== prepared.messageBase64
  )
    throw new Error(
      'Prepared launch message/network context differs. No transaction was submitted.'
    );
  return { message: Uint8Array.from(message), context: prepared };
}
export function verifiedLaunchSignature(expectedMessage: Uint8Array, signed: Transaction): string {
  if (
    !Buffer.from(expectedMessage).equals(signed.serializeMessage()) ||
    !signed.verifySignatures(true) ||
    !signed.signature
  )
    throw new Error(
      'Wallet changed the prepared launch or omitted a required signature. No transaction was submitted.'
    );
  return bs58.encode(signed.signature);
}
export async function submitPreparedLaunch(
  args: {
    signed: Transaction;
    expectedMessage: Uint8Array;
    receipt: Omit<PendingLaunch, 'signature'> & LaunchPreparationContext;
    onSaved?: (receipt: PendingLaunch & LaunchPreparationContext) => void;
  },
  storage?: StorageLike
) {
  const signature = verifiedLaunchSignature(args.expectedMessage, args.signed),
    wire = args.signed.serialize().toString('base64'),
    receipt = { ...args.receipt, signature };
  savePendingLaunch(receipt, storage);
  args.onSaved?.(receipt);
  const response = await fetch('/api/send-transaction', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ signedTransaction: wire }),
    signal: AbortSignal.timeout(10_000),
  }).catch((): null => null);
  const body = response ? await response.json().catch((): null => null) : null;
  return { receipt, relayAccepted: !!response?.ok && body?.signature === signature };
}
export async function checkPendingLaunch(receipt: PendingLaunch) {
  let prepared: LaunchPreparationContext;
  try {
    prepared = context(receipt as unknown as Record<string, unknown>);
  } catch {
    return { safeToRetry: false, state: 'pending' };
  }
  const query = new URLSearchParams({
    ...Object.fromEntries(Object.entries(prepared).map(([key, value]) => [key, String(value)])),
    mint: receipt.mint,
    wallet: receipt.wallet,
    signature: receipt.signature,
  });
  const response = await fetch(`/api/launch/receipt-status?${query}`, {
      signal: AbortSignal.timeout(10_000),
    }),
    body = await response.json();
  if (!response.ok) throw new Error(body.error ?? 'Receipt verification is unavailable');
  if (body.genesis !== prepared.genesis)
    throw new Error('Receipt verification returned another network');
  return body as { safeToRetry: boolean; state: string };
}
/** Retry finality/native/SQL verification only. Never construct or send another launch. */
export async function finishLaunchRegistration(
  mint: string,
  signature: string,
  timeoutMs = 60_000,
  receipt?: Partial<Pick<PendingLaunch, 'genesis' | 'wallet' | 'mode'>>
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch('/api/launch/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mint,
        signature,
        ...(receipt?.genesis ? { genesis: receipt.genesis } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    }).catch((): null => null);
    const body = response ? await response.json().catch((): null => null) : null;
    if (response?.ok && body?.status === 'registered') {
      if (
        body.mint !== mint ||
        (receipt?.genesis && body.genesis !== receipt.genesis) ||
        (receipt?.wallet && body.originalDeployer !== receipt.wallet) ||
        (receipt?.mode && body.mode !== receipt.mode)
      )
        throw new Error('Registered identity differs from your saved receipt. Keep it for review.');
      clearPendingLaunch(mint, receipt?.wallet, receipt?.genesis);
      return;
    }
    if (response && body && ![202, 503, 502, 429].includes(response.status))
      throw new Error(
        body.error ?? 'Launch verification is pending. Keep the receipt and retry confirmation.'
      );
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(
    'Submission or finalization is still pending. Your receipt is saved; check it without launching again.'
  );
}
