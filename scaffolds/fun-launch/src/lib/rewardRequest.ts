import {
  claimAuthorizationMessage,
  type ClaimAuthorization,
  type RewardPayout,
  type RewardsView,
} from './rewards';

export type RewardRequestReceipt = ClaimAuthorization & { version: 1; jobId?: string };
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;
type Scope = Pick<ClaimAuthorization, 'networkGenesis' | 'mint' | 'wallet'>;
const key = (scope: Scope) =>
  `rinsed.rewardRequest.v1:${scope.networkGenesis}:${scope.wallet}:${scope.mint}`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function valid(value: unknown, scope: Scope): value is RewardRequestReceipt {
  if (!value || typeof value !== 'object') return false;
  const receipt = value as RewardRequestReceipt;
  return (
    receipt.version === 1 &&
    typeof receipt.networkGenesis === 'string' &&
    receipt.networkGenesis.length > 0 &&
    typeof receipt.mint === 'string' &&
    receipt.mint.length > 0 &&
    typeof receipt.wallet === 'string' &&
    receipt.wallet.length > 0 &&
    receipt.networkGenesis === scope.networkGenesis &&
    receipt.mint === scope.mint &&
    receipt.wallet === scope.wallet &&
    typeof receipt.requestId === 'string' &&
    uuid.test(receipt.requestId) &&
    (receipt.jobId === undefined || uuid.test(receipt.jobId)) &&
    (receipt.epoch === null ||
      (typeof receipt.epoch === 'string' && /^(0|[1-9]\d{0,9})$/.test(receipt.epoch))) &&
    typeof receipt.amount === 'string' &&
    /^[1-9]\d{0,19}$/.test(receipt.amount) &&
    BigInt(receipt.amount) <= 18446744073709551615n &&
    Number.isSafeInteger(receipt.issuedAt) &&
    receipt.issuedAt > 0
  );
}
export function readRewardRequest(storage: Storage, scope: Scope): RewardRequestReceipt | null {
  const raw = storage.getItem(key(scope));
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return valid(value, scope) ? value : null;
  } catch {
    return null;
  }
}
/** Persist only the public intent before requesting a payout; no signature or transaction bytes. */
export function saveRewardRequest(storage: Storage, receipt: RewardRequestReceipt) {
  if (!valid(receipt, receipt)) throw new Error('Invalid reward request receipt');
  const { version, networkGenesis, mint, wallet, epoch, amount, requestId, issuedAt, jobId } =
    receipt;
  storage.setItem(
    key(receipt),
    JSON.stringify({
      version,
      networkGenesis,
      mint,
      wallet,
      epoch,
      amount,
      requestId,
      issuedAt,
      ...(jobId ? { jobId } : {}),
    })
  );
}
export function clearRewardRequest(storage: Storage, receipt: RewardRequestReceipt) {
  if (readRewardRequest(storage, receipt)?.requestId === receipt.requestId)
    storage.removeItem(key(receipt));
}
/** Clearing a browser receipt never cancels or releases a server-side payout. */
export function clearUnrecordedRewardRequest(
  storage: Storage,
  receipt: RewardRequestReceipt,
  fresh: RewardsView,
  now = Date.now()
) {
  if (
    fresh.status !== 'ready' ||
    fresh.networkGenesis !== receipt.networkGenesis ||
    !Object.hasOwn(fresh, 'request') ||
    fresh.request !== null ||
    fresh.creatorJob ||
    now <= receipt.issuedAt + 330_000
  )
    throw new Error('Check this saved request again after its authorization expires.');
  clearRewardRequest(storage, receipt);
}

export async function requestRewardPayout({
  input,
  origin,
  signMessage,
  storage,
  submit,
  onSaved,
}: {
  input: ClaimAuthorization;
  origin: string;
  signMessage: (message: Uint8Array) => Promise<Uint8Array>;
  storage: Storage;
  submit: (body: object) => Promise<RewardPayout>;
  onSaved?: (receipt: RewardRequestReceipt) => void;
}) {
  const { networkGenesis, mint, wallet, epoch, amount, requestId, issuedAt } = input;
  const authorization = { networkGenesis, mint, wallet, epoch, amount, requestId, issuedAt };
  const signature = await signMessage(
    new TextEncoder().encode(claimAuthorizationMessage(origin, authorization))
  );
  if (!(signature instanceof Uint8Array) || signature.length !== 64)
    throw new Error('Your wallet returned an invalid message signature');
  const pending: RewardRequestReceipt = { ...authorization, version: 1 };
  saveRewardRequest(storage, pending);
  onSaved?.(pending);
  const job = await submit({
    action: 'prepare',
    ...authorization,
    signature: Buffer.from(signature).toString('base64'),
  });
  if (job.requestId !== input.requestId || job.amount !== input.amount)
    throw new Error('Unexpected payout receipt. Check your saved request.');
  const receipt = { ...pending, jobId: job.id };
  saveRewardRequest(storage, receipt);
  onSaved?.(receipt);
  return { job, receipt };
}
