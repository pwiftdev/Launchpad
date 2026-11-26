import { useEffect, useState } from 'react';
import { BRAND } from '@/constants/brand';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useUnifiedWalletContext, useWallet } from '@jup-ag/wallet-adapter';
import { toast } from 'sonner';
import type { Coin } from '@/lib/coin';
import modePolicy from '@/constants/modePolicy.json';
import {
  hasBatchedHolderRewards,
  hasCreatorRewards,
  isWalletPolicy,
  isMskdMode,
} from '@/lib/launchModes';
import {
  rewardHourEnd,
  type ClaimAuthorization,
  type RewardPayout,
  type RewardsView,
} from '@/lib/rewards';
import {
  clearRewardRequest,
  clearUnrecordedRewardRequest,
  readRewardRequest,
  requestRewardPayout,
  type RewardRequestReceipt,
} from '@/lib/rewardRequest';
import { explorerUrl } from '@/constants/network';
import { Button } from '../ui/button';
import { formatSol as sol, formatTokenUnits } from '@/lib/tokenUnits';

class RejectedPayoutRequest extends Error {}
async function request(body: object): Promise<RewardPayout> {
  const response = await fetch('/api/rewards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const result = await response.json();
  if (!response.ok) {
    const message = result.error ?? 'Could not request your reward';
    if (
      result.requestAccepted === false ||
      [400, 401, 403, 409, 415, 429].includes(response.status)
    )
      throw new RejectedPayoutRequest(message);
    throw new Error(message);
  }
  return result as RewardPayout;
}
export function RewardsPanel({ coin }: { coin: Coin }) {
  const { publicKey } = useWallet();
  return <WalletRewards key={`${coin.mint}:${publicKey?.toBase58() ?? ''}`} coin={coin} />;
}
function WalletRewards({ coin }: { coin: Coin }) {
  const { publicKey, signMessage } = useWallet();
  const { setShowModal } = useUnifiedWalletContext();
  const wrappedMonero = !!coin.mode && isMskdMode(coin.mode);
  const hsol = coin.quoteMint === modePolicy.quotes.hsol.mint;
  const asset = wrappedMonero ? 'wXMR' : hsol ? 'hSOL' : 'SOL';
  const formatAmount = (amount: string) =>
    wrappedMonero || hsol
      ? `${formatTokenUnits(amount, wrappedMonero ? modePolicy.payouts.wxmr.decimals : modePolicy.quotes.hsol.decimals)} ${asset}`
      : sol(amount);
  const cache = useQueryClient(),
    wallet = publicKey?.toBase58();
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<RewardRequestReceipt | null>(null);
  const [unrecorded, setUnrecorded] = useState(false);
  const [beforeEpoch, setBeforeEpoch] = useState<string | null>(null);
  const key = ['rewards', coin.mint, wallet];
  async function readView(requestId?: string): Promise<RewardsView> {
    const query = new URLSearchParams({ mint: coin.mint, wallet: wallet! });
    if (beforeEpoch) query.set('beforeEpoch', beforeEpoch);
    if (requestId) query.set('requestId', requestId);
    const response = await fetch(`/api/rewards?${query}`, { signal: AbortSignal.timeout(15_000) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? 'Rewards are temporarily unavailable');
    return data;
  }
  const rewards = useQuery<RewardsView>({
    queryKey: [...key, beforeEpoch, receipt?.requestId],
    enabled: !!wallet && !coin.isDemo && isWalletPolicy(coin.feePolicyVersion ?? ''),
    queryFn: () => readView(receipt?.requestId),
    refetchInterval: 15_000,
    retry: 1,
  });
  const data = rewards.data,
    genesis = data?.networkGenesis;
  useEffect(() => {
    if (!genesis || !wallet) return;
    try {
      setReceipt(
        readRewardRequest(window.localStorage, { networkGenesis: genesis, mint: coin.mint, wallet })
      );
    } catch {
      setNotice(
        'Browser storage is unavailable. Enable it before requesting a payout so a lost response can be recovered.'
      );
    }
  }, [genesis, wallet, coin.mint]);
  useEffect(() => {
    const job = data?.request;
    if (
      !receipt ||
      data?.networkGenesis !== receipt.networkGenesis ||
      job?.requestId !== receipt.requestId ||
      !['finalized', 'failed'].includes(job.status)
    )
      return;
    try {
      clearRewardRequest(window.localStorage, receipt);
      setReceipt(null);
      setNotice(
        job.status === 'finalized'
          ? `Your ${asset} reward is confirmed.`
          : 'This payout did not complete. Refresh the funded balance before requesting it again.'
      );
    } catch {
      setNotice(
        'Payment status is available, but this browser could not update its saved receipt.'
      );
    }
  }, [asset, data?.request, data?.networkGenesis, receipt]);
  if (coin.isDemo || !coin.mode) return null;
  if (!isWalletPolicy(coin.feePolicyVersion ?? ''))
    return (
      <section aria-label="Token rewards" className="px-4 pb-4">
        <p className="flex h-10 items-center text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
          Token rewards
        </p>
        <p className="mt-2 text-xs text-neutral-500">
          This token uses its original launch policy. New wallet payout requests are unavailable
          here.
        </p>
      </section>
    );

  function showStatus(job: RewardPayout, saved?: RewardRequestReceipt | null) {
    setUnrecorded(false);
    if (job.status === 'finalized') {
      if (saved) {
        clearRewardRequest(window.localStorage, saved);
        setReceipt(null);
      }
      setNotice(`Your ${asset} reward is confirmed.`);
      toast.success(`${asset} reward paid`);
    } else if (job.status === 'failed') {
      if (saved) {
        clearRewardRequest(window.localStorage, saved);
        setReceipt(null);
      }
      setNotice(
        'This payout did not complete. Refresh the funded balance before requesting it again.'
      );
    } else
      setNotice(
        'Your payout request is saved. Payment is pending; use Check request before requesting it again.'
      );
  }
  async function check(id?: string) {
    setBusy(true);
    setNotice(null);
    try {
      if (receipt) {
        const current = await readView(receipt.requestId);
        if (current.networkGenesis !== receipt.networkGenesis)
          throw new Error('The reward network changed. Switch back to check this saved request.');
        if (current.request) showStatus(current.request, receipt);
        else {
          setUnrecorded(!current.creatorJob && current.status === 'ready');
          setNotice(
            'No payout is recorded for this request yet. After its authorization expires, you can clear the saved request and try again.'
          );
        }
      } else if (id && genesis && wallet) {
        showStatus(
          await request({ action: 'settle', id, networkGenesis: genesis, mint: coin.mint, wallet })
        );
      }
      await cache.invalidateQueries({ queryKey: key });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not check your payout');
    } finally {
      setBusy(false);
    }
  }
  async function clearMissing() {
    if (!receipt) return;
    setBusy(true);
    try {
      const fresh = await readView(receipt.requestId);
      clearUnrecordedRewardRequest(window.localStorage, receipt, fresh);
      setReceipt(null);
      setUnrecorded(false);
      setNotice(
        'The expired local receipt was cleared. Refresh your rewards before requesting again.'
      );
      await cache.invalidateQueries({ queryKey: key });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Check your saved request again.');
    } finally {
      setBusy(false);
    }
  }
  async function claim(epoch: string | null, amount: string, assetMint?: string) {
    if (!publicKey) return setShowModal(true);
    if (!signMessage)
      return setNotice('Use a wallet that supports message signing to request your reward.');
    if (receipt) return check();
    setBusy(true);
    setNotice(null);
    let saved: RewardRequestReceipt | null = null;
    setUnrecorded(false);
    try {
      const input: ClaimAuthorization = {
        networkGenesis: genesis ?? '',
        mint: coin.mint,
        wallet: publicKey.toBase58(),
        epoch,
        amount,
        requestId: crypto.randomUUID(),
        issuedAt: Date.now(),
        ...(assetMint ? { assetMint } : {}),
      };
      if (!input.networkGenesis)
        throw new Error('Verified network is unavailable. Reload before requesting a payout.');
      // Save the public request before the first POST. A lost response never triggers another payout.
      const result = await requestRewardPayout({
        input,
        origin: window.location.origin,
        signMessage,
        storage: window.localStorage,
        submit: request,
        onSaved: (value) => {
          saved = value;
          setReceipt(value);
        },
      });
      showStatus(result.job, result.receipt);
    } catch (error) {
      // A positive rejection occurs before reservation. Uncertain responses keep their receipt.
      if (error instanceof RejectedPayoutRequest && saved) {
        clearRewardRequest(window.localStorage, saved);
        setReceipt(null);
      }
      setNotice(
        error instanceof Error
          ? error.message
          : 'The wallet request was cancelled or could not be completed.'
      );
    } finally {
      setBusy(false);
      await cache.invalidateQueries({ queryKey: key });
    }
  }
  const available = data?.availableLamports ?? '0';
  const pending = receipt || data?.creatorJob;
  const batched = hasBatchedHolderRewards(coin.mode);
  const holderClaim = data?.holderClaim;
  const hourly = coin.mode === 'community' || batched;
  return (
    <section aria-label="Token rewards" className="px-4 pb-4">
      <p className="flex h-10 items-center text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
        {hasCreatorRewards(coin.mode)
          ? 'Creator rewards'
          : batched
            ? 'Holder rewards'
            : 'Community rewards'}
      </p>
      {coin.mode === 'bond' && (
        <p className="mb-3 text-xs leading-relaxed text-neutral-500">
          Creator rewards start after bonding. Only the original creator can claim collected income.
          Before bonding, the creator share funds same-token buybacks and burns.
        </p>
      )}
      {!wallet ? (
        <>
          <p className="mt-2 text-xs text-neutral-500">
            Connect your wallet to view funded {asset} rewards.
          </p>
          <Button variant="outline" className="mt-3 w-full" onClick={() => setShowModal(true)}>
            Connect wallet
          </Button>
        </>
      ) : (
        <>
          <p className="mt-2 font-mono text-xl text-foreground">{formatAmount(available)}</p>
          <p className="mt-1 text-xs text-neutral-500">
            {coin.mode === 'community' ? 'Available on this page' : `Available ${asset} rewards`}
          </p>
          {data?.reservedLamports && BigInt(data.reservedLamports) > 0n && (
            <p className="mt-2 text-xs text-neutral-400">
              Reserved for payout: {formatAmount(data.reservedLamports)}
            </p>
          )}
          {data?.paidLamports && BigInt(data.paidLamports) > 0n && (
            <p className="mt-2 text-xs text-neutral-400">Paid: {formatAmount(data.paidLamports)}</p>
          )}
          {hasCreatorRewards(coin.mode) &&
            data?.creatorReceipts?.map((item) => (
              <a
                key={item.signature}
                className="mt-2 block text-xs text-primary"
                target="_blank"
                rel="noopener noreferrer"
                href={explorerUrl(`tx/${item.signature}`)}
              >
                {sol(item.lamports)} · Receipt ↗
              </a>
            ))}
          {rewards.isLoading && (
            <p className="mt-3 text-xs text-neutral-500">Checking funded balances…</p>
          )}
          {rewards.isError && (
            <p className="mt-3 text-xs text-neutral-500">
              Rewards are temporarily unavailable. Saved requests remain pending.
            </p>
          )}
          {pending && (
            <Button
              variant="outline"
              className="mt-3 w-full"
              disabled={busy}
              onClick={() => check(data?.creatorJob?.id)}
            >
              Check saved request
            </Button>
          )}
          {unrecorded &&
            receipt &&
            data?.request === null &&
            !data.creatorJob &&
            Date.now() > receipt.issuedAt + 330_000 && (
              <Button
                variant="outline"
                className="mt-2 w-full"
                disabled={busy}
                onClick={clearMissing}
              >
                Clear expired request
              </Button>
            )}
          {!pending && hasCreatorRewards(coin.mode) && BigInt(available) > 0n && (
            <Button
              className="mt-3 w-full"
              disabled={busy}
              onClick={() =>
                claim(
                  null,
                  available,
                  coin.mode === 'hsol' ? modePolicy.quotes.hsol.mint : undefined
                )
              }
            >
              {busy ? 'Requesting…' : `Request ${asset} payout`}
            </Button>
          )}
          {!pending && holderClaim && (
            <Button
              className="mt-3 w-full"
              disabled={busy}
              onClick={() =>
                claim(holderClaim.throughEpoch, holderClaim.amount, holderClaim.assetMint)
              }
            >
              {busy ? 'Requesting…' : `Request ${asset} payout`}
            </Button>
          )}
          {!holderClaim && !pending && batched && BigInt(available) > 0n && (
            <p className="mt-3 text-xs text-neutral-500">
              Your rewards roll over until you reach {wrappedMonero ? 'the equivalent of ' : ''}
              0.001 {hsol ? 'hSOL' : 'SOL'}.
            </p>
          )}
          {hourly &&
            data?.epochs.map((epoch) => (
              <div
                key={epoch.epoch}
                className="mt-3 flex items-center justify-between gap-2 border-t border-neutral-850 pt-3 text-xs"
              >
                <div>
                  <p className="font-mono text-neutral-200">{formatAmount(epoch.lamports)}</p>
                  <p
                    className="mt-1 text-neutral-500"
                    title={
                      epoch.snapshotDigest
                        ? `Snapshot slot ${epoch.snapshotSlot} · ${epoch.snapshotDigest}`
                        : undefined
                    }
                  >
                    {batched
                      ? rewardHourEnd(epoch.epoch).toISOString().slice(0, 16).replace('T', ' ') +
                        ' UTC'
                      : `Hour ${epoch.epoch}`}{' '}
                    · {epoch.status === 'pending' ? 'payment pending' : epoch.status}
                  </p>
                  {epoch.conversionSignature && (
                    <a
                      className="mt-1 inline-block text-primary"
                      target="_blank"
                      rel="noreferrer"
                      href={explorerUrl(`tx/${epoch.conversionSignature}`)}
                    >
                      Conversion receipt
                    </a>
                  )}
                </div>
                {epoch.status === 'available' && !batched ? (
                  <Button
                    size="sm"
                    disabled={busy || !!pending}
                    onClick={() => claim(epoch.epoch, epoch.lamports)}
                  >
                    Request
                  </Button>
                ) : epoch.status === 'pending' && epoch.jobId ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => check(epoch.jobId!)}
                  >
                    Check
                  </Button>
                ) : epoch.signature ? (
                  <a
                    className="text-primary"
                    target="_blank"
                    rel="noreferrer"
                    href={explorerUrl(`tx/${epoch.signature}`)}
                  >
                    Receipt ↗
                  </a>
                ) : null}
              </div>
            ))}
          {hourly && (beforeEpoch || data?.nextEpoch) && (
            <div className="mt-3 flex gap-3 text-xs">
              {beforeEpoch && (
                <button
                  type="button"
                  disabled={busy || rewards.isFetching}
                  onClick={() => setBeforeEpoch(null)}
                  className="text-primary disabled:opacity-50"
                >
                  Newest rewards
                </button>
              )}
              {data?.nextEpoch && (
                <button
                  type="button"
                  disabled={busy || rewards.isFetching}
                  onClick={() => setBeforeEpoch(data.nextEpoch!)}
                  className="text-primary disabled:opacity-50"
                >
                  Older rewards
                </button>
              )}
            </div>
          )}
          <p className="mt-3 text-[11px] leading-relaxed text-neutral-500">
            Sign a message to request {asset} to this wallet. {BRAND.name} pays the network fee. No
            token approval, transaction signature, or claim account is needed.
          </p>
        </>
      )}
      {notice && (
        <p role="status" className="mt-3 text-xs leading-relaxed text-neutral-400">
          {notice}
        </p>
      )}
    </section>
  );
}
