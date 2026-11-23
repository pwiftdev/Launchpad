import { useEffect, useId, useRef, useState } from 'react';
import bs58 from 'bs58';
import { Transaction } from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';
import { useUnifiedWalletContext, useWallet } from '@jup-ag/wallet-adapter';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { BalanceResponse, Coin, QuoteResponse } from '@/lib/coin';
import { BASE_FEE_PERCENT } from '@/constants/launch';
import { explorerUrl, NETWORK, NETWORK_LABEL } from '@/constants/network';
import { formatReadableNumber } from '@/lib/format/number';
import { useUsd } from '@/hooks/useUsd';
import { burstSparkles } from '@/lib/sparkles';
import { cn } from '@/lib/utils';
import { Button } from '../ui/button';
import { CoinAvatar } from '../coin/CoinAvatar';
import { confirmTransaction } from '@/lib/confirmTransaction';
import { readTradeReceipt, tradeReceiptKey, type TradeReceipt } from '@/lib/tradeReceipt';
import {
  migrationReceiptKey,
  readMigrationReceipt,
  writeMigrationReceipt,
  type MigrationReceipt,
} from '@/lib/migrationReceipt';

type Side = 'buy' | 'sell';
const BUY_PRESETS = [0.1, 0.5, 1, 2];
const SELL_PRESETS = [25, 50, 75, 100];
/** Left in the wallet on a max buy, for network fees and account rent. */
const BUY_SOL_RESERVE = 0.01;
/** The swap route's default slippage bound (see swapSchema). */
const DEFAULT_SLIPPAGE_PERCENT = 3;

export const TradeBox = ({ coin, className }: { coin: Coin; className?: string }) => {
  const amountId = useId();
  const { publicKey, signTransaction } = useWallet();
  const { setShowModal } = useUnifiedWalletContext();
  const queryClient = useQueryClient();
  const [side, setSide] = useState<Side>('buy');
  const [amount, setAmount] = useState('');
  const [sending, setSending] = useState(false);
  const tradeKey = tradeReceiptKey(NETWORK, coin.mint, publicKey?.toBase58() ?? '');
  const [storedTrade, setStoredTrade] = useState<{
    key: string;
    receipt: TradeReceipt | null;
  } | null>(null);
  const [tradeNotice, setTradeNotice] = useState<string | null>(null);
  const [expiredTrade, setExpiredTrade] = useState(false);
  const tradeInFlight = useRef(false);
  const pendingTrade = storedTrade?.key === tradeKey ? storedTrade.receipt : null;
  useEffect(() => {
    setExpiredTrade(false);
    setTradeNotice(null);
    try {
      setStoredTrade({ key: tradeKey, receipt: readTradeReceipt(localStorage, tradeKey) });
    } catch (error) {
      setTradeNotice(error instanceof Error ? error.message : 'Saved trade receipt is unavailable');
    }
  }, [tradeKey]);
  function saveTrade(receipt: TradeReceipt | null) {
    // A signed transaction must have a durable public receipt before it is sent.
    if (receipt) localStorage.setItem(tradeKey, JSON.stringify(receipt));
    else localStorage.removeItem(tradeKey);
    setStoredTrade({ key: tradeKey, receipt });
    setExpiredTrade(false);
  }
  const receiptKey = migrationReceiptKey(NETWORK, coin.mint);
  const [storedMigration, setStoredMigration] = useState<{
    key: string;
    receipt: MigrationReceipt | null;
  } | null>(null);
  const pendingMigration = storedMigration?.key === receiptKey ? storedMigration.receipt : null;
  useEffect(() => {
    try {
      setStoredMigration({
        key: receiptKey,
        receipt: readMigrationReceipt(localStorage, receiptKey),
      });
    } catch {
      setStoredMigration(null);
    }
  }, [receiptKey]);
  const saveReceipt = (receipt: MigrationReceipt | null) => {
    setStoredMigration({ key: receiptKey, receipt });
    try {
      if (receipt) writeMigrationReceipt(localStorage, receiptKey, receipt);
      else localStorage.removeItem(receiptKey);
    } catch {
      /* Receipt remains in memory when browser storage is unavailable. */
    }
  };
  const { quote, error, loading } = useQuote(coin.mint, side, Number(amount));
  const balance = useBalance(coin.mint, publicKey?.toBase58(), !coin.isDemo);
  const { usd, price } = useUsd();

  const taxed = quote ? quote.feePercent > BASE_FEE_PERCENT + 0.05 : false;
  const submitRef = useRef<HTMLButtonElement>(null);

  async function trade() {
    if (coin.isDemo) return;
    if (!publicKey || !signTransaction) return setShowModal(true);
    if (tradeInFlight.current) return;
    tradeInFlight.current = true;
    setSending(true);
    try {
      const saved = readTradeReceipt(localStorage, tradeKey);
      if (saved) {
        await recoverTrade(saved, false);
        return;
      }
      const res = await fetch('/api/swap-tx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mint: coin.mint,
          side,
          amount: Number(amount),
          wallet: publicKey.toBase58(),
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      const prepared = Transaction.from(Buffer.from(body.tx, 'base64'));
      const message = Buffer.from(prepared.serializeMessage());
      const signed = await signTransaction(prepared);
      if (
        !Buffer.from(signed.serializeMessage()).equals(message) ||
        !signed.signature ||
        !signed.verifySignatures()
      )
        throw new Error('The wallet returned a different or incomplete trade transaction');
      const receipt: TradeReceipt = {
        signature: bs58.encode(signed.signature),
        genesis: body.genesis,
        lastValidBlockHeight: body.lastValidBlockHeight,
        preparedSlot: body.preparedSlot,
      };
      // Validate server expiry/network fields before persisting or broadcasting.
      readTradeReceipt({ getItem: () => JSON.stringify(receipt) }, tradeKey);
      saveTrade(receipt);
      const sendRes = await fetch('/api/send-transaction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signedTransaction: signed.serialize().toString('base64') }),
      });
      const sent = await sendRes.json();
      if (!sendRes.ok)
        throw new Error('Trade receipt saved. Check it before starting another trade.');
      if (sent.signature !== receipt.signature)
        throw new Error('Unexpected trade receipt. Check your saved transaction.');
      await recoverTrade(receipt, true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Trade failed');
    } finally {
      tradeInFlight.current = false;
      setSending(false);
    }
  }
  async function recoverTrade(receipt: TradeReceipt, wait: boolean) {
    const until = Date.now() + (wait ? 60_000 : 0);
    do {
      const params = new URLSearchParams({
        signature: receipt.signature,
        lastValidBlockHeight: String(receipt.lastValidBlockHeight),
        preparedSlot: String(receipt.preparedSlot),
        genesis: receipt.genesis,
      });
      const response = await fetch(`/api/transaction-status?${params}`, {
        signal: AbortSignal.timeout(10_000),
      });
      const status = await response.json();
      if (!response.ok) throw new Error(status.error || 'Could not check saved trade');
      if (status.finalized) {
        saveTrade(null);
        setAmount('');
        setTradeNotice(
          status.failed ? 'The trade failed on-chain. No swap settled.' : 'Your trade is finalized.'
        );
        if (!status.failed) {
          toast.success('Trade confirmed', {
            description: `Finalized on ${NETWORK_LABEL}.`,
            action: {
              label: 'Receipt',
              onClick: () =>
                window.open(
                  explorerUrl(`tx/${receipt.signature}`),
                  '_blank',
                  'noopener,noreferrer'
                ),
            },
          });
          burstSparkles(submitRef.current, 12);
        }
        for (const key of [
          ['coin', coin.mint],
          ['holders', coin.mint],
          ['trades', coin.mint],
          ['balance', coin.mint],
        ])
          void queryClient.invalidateQueries({ queryKey: key });
        return;
      }
      if (status.expired) {
        setExpiredTrade(true);
        setTradeNotice(
          'This signed transaction expired. Check its receipt and wallet history before starting another trade.'
        );
        return;
      }
      if (status.historyIncomplete) {
        setTradeNotice(
          'RPC history is incomplete. Keep this receipt and verify the transaction in your wallet.'
        );
        return;
      }
      if (!wait) break;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    } while (Date.now() < until);
    setTradeNotice('Trade confirmation is pending. Check the saved receipt before trading again.');
  }
  async function checkTrade() {
    if (!pendingTrade || tradeInFlight.current) return;
    tradeInFlight.current = true;
    setSending(true);
    try {
      await recoverTrade(pendingTrade, false);
    } catch (error) {
      setTradeNotice(error instanceof Error ? error.message : 'Could not check saved trade');
    } finally {
      tradeInFlight.current = false;
      setSending(false);
    }
  }

  async function graduate() {
    setSending(true);
    try {
      let saved = pendingMigration;
      try {
        saved ??= readMigrationReceipt(localStorage, receiptKey);
      } catch {
        /* Use in-memory receipt. */
      }
      if (saved) {
        await recoverGraduation(saved);
        return;
      }
      if (!publicKey || !signTransaction) {
        setShowModal(true);
        return;
      }
      const response = await fetch('/api/launch/migrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mint: coin.mint, wallet: publicKey.toBase58() }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      if (
        !Array.isArray(data.transactions) ||
        !data.transactions.every((value: unknown) => typeof value === 'string')
      )
        throw new Error('Invalid graduation preparation');
      let receipt: MigrationReceipt | undefined;
      for (const [index, encoded] of (data.transactions as string[]).entries()) {
        const signed = await signTransaction(Transaction.from(Buffer.from(encoded, 'base64')));
        if (!signed.signature || !signed.verifySignatures())
          throw new Error('A fully signed graduation transaction is required');
        if (index === data.transactions.length - 1) {
          receipt = {
            signature: bs58.encode(signed.signature),
            lastValidBlockHeight: data.lastValidBlockHeight,
            preparedSlot: data.preparedSlot,
            savedAt: Date.now(),
          };
          saveReceipt(receipt);
        }
        const relay = await fetch('/api/send-transaction', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ signedTransaction: signed.serialize().toString('base64') }),
        });
        const result = await relay.json();
        if (!relay.ok) throw new Error(result.error);
        if (receipt && result.signature !== receipt.signature)
          throw new Error(
            'Unexpected graduation receipt. Check the saved transaction before retrying.'
          );
        if (index !== data.transactions.length - 1) await confirmTransaction(result.signature);
      }
      if (receipt) await recoverGraduation(receipt);
      else refreshGraduation();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not complete graduation');
    } finally {
      setSending(false);
    }
  }
  function refreshGraduation() {
    for (const key of [
      ['coin', coin.mint],
      ['coins'],
      ['market-stats'],
      ['trades', coin.mint],
      ['holders', coin.mint],
    ])
      void queryClient.invalidateQueries({ queryKey: key });
  }
  async function recoverGraduation(receipt: MigrationReceipt) {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const response = await fetch('/api/launch/confirm-migration', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mint: coin.mint, signature: receipt.signature }),
        signal: AbortSignal.timeout(10_000),
      }).catch((): null => null);
      if (response?.status === 200) {
        saveReceipt(null);
        refreshGraduation();
        toast.success('Graduation confirmed');
        return;
      }
      const query = new URLSearchParams({ signature: receipt.signature });
      if (receipt.lastValidBlockHeight !== undefined)
        query.set('lastValidBlockHeight', String(receipt.lastValidBlockHeight));
      if (receipt.preparedSlot !== undefined)
        query.set('preparedSlot', String(receipt.preparedSlot));
      const statusResponse = await fetch(`/api/transaction-status?${query}`, {
        signal: AbortSignal.timeout(10_000),
      }).catch((): null => null);
      if (statusResponse?.ok) {
        const status = await statusResponse.json();
        if (status.failed || status.expired) {
          saveReceipt(null);
          refreshGraduation();
          throw new Error(
            status.failed
              ? 'Graduation failed on chain. Reload before preparing another transaction.'
              : 'The signed graduation transaction expired. Reload the current pool before trying again.'
          );
        }
      }
      if (response?.status === 422)
        throw new Error(
          'Graduation receipt is saved. Recheck it before preparing another migration.'
        );
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    refreshGraduation();
    toast.info('Graduation is still awaiting confirmation. Its receipt is saved for retry.');
  }

  if (coin.isDemo) {
    return (
      <section className={cn('p-4', className)} aria-label="Preview trading unavailable">
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-neutral-900 p-1 opacity-50">
          <span className="rounded-md bg-emerald py-2 text-center text-sm font-semibold text-ink">
            Buy
          </span>
          <span className="py-2 text-center text-sm font-semibold text-neutral-400">Sell</span>
        </div>
        <p className="mt-4 text-sm font-semibold">Here for the looks</p>
        <p className="mt-1 text-xs leading-relaxed text-neutral-400">
          This is a sample coin for exploring the design. Its price, trades and holders are
          simulated.
        </p>
        <div className="mt-4 flex h-11 items-center justify-center rounded-lg bg-neutral-900 text-xs text-neutral-500">
          Trading unavailable for samples
        </div>
      </section>
    );
  }

  if (!coin.isMigrated && coin.thresholdSol > 0 && coin.quoteReserveSol >= coin.thresholdSol) {
    return (
      <section className={cn('p-4 text-sm text-neutral-300', className)}>
        <p className="font-semibold">Ready to graduate</p>
        <p className="mt-1 text-xs leading-relaxed text-neutral-400">
          The curve reached its target. Complete the on-chain migration to resume trading on Meteora
          DAMM v2.
        </p>
        <Button className="mt-4 h-11 w-full" disabled={sending} onClick={graduate}>
          {sending
            ? 'Confirming graduation…'
            : pendingMigration
              ? 'Check saved graduation'
              : 'Complete graduation'}
        </Button>
        <p className="mt-2 text-[11px] text-neutral-500">
          Your wallet shows network fees and any new-account rent before signing.
        </p>
      </section>
    );
  }

  const numericAmount = Number(amount);
  const available = side === 'buy' ? balance?.sol : balance?.tokens;
  const unit = side === 'buy' ? 'SOL' : coin.symbol;
  const short = available !== undefined && numericAmount > available;
  const setFraction = (fraction: number) => {
    if (!balance) return;
    const value =
      side === 'buy'
        ? Math.max(0, balance.sol * fraction - (fraction === 1 ? BUY_SOL_RESERVE : 0))
        : balance.tokens * fraction;
    const rounded = Math.floor(value * 1e6) / 1e6;
    setAmount(rounded > 0 ? String(rounded) : '');
  };

  return (
    <section aria-label="Trade" className={cn('flex flex-col gap-3 p-4', className)}>
      {pendingTrade && (
        <div
          className="rounded-lg border border-amber/30 bg-amber/5 p-3 text-xs text-neutral-300"
          role="status"
        >
          <p>A saved trade needs confirmation.</p>
          <div className="mt-2 flex flex-wrap gap-3">
            <button
              type="button"
              disabled={sending}
              onClick={checkTrade}
              className="text-primary disabled:opacity-50"
            >
              Check saved trade
            </button>
            <a
              className="text-primary"
              href={explorerUrl(`tx/${pendingTrade.signature}`)}
              target="_blank"
              rel="noopener noreferrer"
            >
              Receipt ↗
            </a>
          </div>
          {expiredTrade && (
            <button
              type="button"
              disabled={sending}
              onClick={() => {
                try {
                  saveTrade(null);
                  setAmount('');
                  setTradeNotice(null);
                } catch {
                  setTradeNotice('Could not clear this browser receipt.');
                }
              }}
              className="mt-2 block text-amber"
            >
              I checked my wallet — start a new trade
            </button>
          )}
        </div>
      )}
      {tradeNotice && (
        <p role="status" className="text-xs leading-relaxed text-neutral-400">
          {tradeNotice}
        </p>
      )}
      {coin.isMigrated && pendingMigration && (
        <div className="rounded-lg border border-neutral-800 p-2.5 text-xs text-neutral-400">
          Graduation is live. Its saved receipt still needs indexing.
          <button
            type="button"
            className="ml-2 text-primary underline"
            disabled={sending}
            onClick={graduate}
          >
            {sending ? 'Checking…' : 'Check receipt'}
          </button>
          <a
            className="ml-2 text-primary underline"
            href={explorerUrl(`tx/${pendingMigration.signature}`)}
            target="_blank"
            rel="noreferrer"
          >
            View transaction
          </a>
        </div>
      )}

      <div role="tablist" className="grid h-10 grid-cols-2 gap-1 rounded-lg bg-neutral-900 p-1">
        {(['buy', 'sell'] as const).map((s) => (
          <button
            key={s}
            role="tab"
            aria-selected={side === s}
            onClick={() => {
              setSide(s);
              setAmount('');
            }}
            className={cn(
              'rounded-md text-sm font-semibold capitalize transition-colors',
              side === s
                ? s === 'buy'
                  ? 'bg-emerald text-ink shadow-sm'
                  : 'bg-rose text-white shadow-sm'
                : 'text-neutral-400 hover:text-neutral-100'
            )}
          >
            {s}
          </button>
        ))}
      </div>

      <div
        className={cn(
          'rounded-lg border bg-neutral-925 px-3 pb-2 pt-2 transition-colors focus-within:border-primary/60',
          short ? 'border-rose/50' : 'border-neutral-800'
        )}
      >
        <div className="flex h-5 items-center justify-between text-[11px]">
          <label htmlFor={amountId} className="font-medium text-neutral-500">
            {side === 'buy' ? 'You pay' : 'You sell'}
          </label>
          {publicKey && (
            <button
              type="button"
              onClick={() => setFraction(1)}
              disabled={!balance}
              className="inline-flex items-center gap-1 font-mono text-neutral-500 hover:text-neutral-200 disabled:hover:text-neutral-500"
              title="Use your full balance"
            >
              <span className="iconify h-3 w-3 ph--wallet" />
              {available === undefined
                ? '…'
                : side === 'buy'
                  ? available.toFixed(available < 1 ? 4 : 3)
                  : formatReadableNumber(available)}
            </button>
          )}
        </div>
        <div className="mt-1 flex items-center gap-2">
          <input
            id={amountId}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
            className="min-w-0 flex-1 bg-transparent font-mono text-2xl font-medium tabular-nums text-foreground outline-none placeholder:text-neutral-700"
          />
          <span className="flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-neutral-850 pl-1 pr-2.5 text-xs font-semibold">
            {side === 'buy' ? (
              <span className="grid h-5 w-5 place-items-center rounded-full bg-gradient-to-br from-[#9945FF] to-[#14F195] text-[9px] font-bold text-white">
                ◎
              </span>
            ) : (
              <CoinAvatar image={coin.image} symbol={coin.symbol} className="h-5 w-5 text-[8px]" />
            )}
            <span className="max-w-20 truncate">{unit}</span>
          </span>
        </div>
        <p className="mt-0.5 h-4 font-mono text-[11px] text-neutral-500">
          {short ? (
            <span className="text-rose">Insufficient balance</span>
          ) : side === 'buy' && price && numericAmount > 0 ? (
            `≈ ${usd(numericAmount)}`
          ) : null}
        </p>
      </div>

      <div className="grid grid-cols-4 gap-1.5">
        {side === 'buy'
          ? BUY_PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setAmount(String(p))}
                className={cn(
                  presetClass,
                  numericAmount === p && 'border-emerald/40 bg-emerald/10 text-emerald'
                )}
              >
                {p} SOL
              </button>
            ))
          : SELL_PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                disabled={!balance?.tokens}
                onClick={() => setFraction(p / 100)}
                className={presetClass}
              >
                {p === 100 ? 'Max' : `${p}%`}
              </button>
            ))}
      </div>

      <dl
        className={cn(
          'space-y-1.5 rounded-lg px-3 py-2.5 text-xs',
          taxed ? 'bg-rose/[0.08]' : 'bg-neutral-925'
        )}
        aria-live="polite"
      >
        {error ? (
          <p className="text-rose">{error}</p>
        ) : quote ? (
          <>
            <Row label="You receive">
              <span className="font-semibold text-foreground">
                {formatReadableNumber(quote.amountOut)} {side === 'buy' ? coin.symbol : 'SOL'}
              </span>
              {side === 'sell' && price && (
                <span className="ml-1.5 text-neutral-500">{usd(quote.amountOut)}</span>
              )}
            </Row>
            <Row
              label={taxed ? 'Snipe tax on this trade' : 'Fee on this trade'}
              labelClass={taxed ? 'font-semibold text-rose' : undefined}
              title={
                quote.feeMint && quote.feeMint !== NATIVE_MINT.toBase58()
                  ? `${formatReadableNumber(quote.feeAmount ?? 0)} ${coin.symbol} · SOL equivalent estimated`
                  : `${quote.feeSol.toFixed(quote.feeSol < 0.01 ? 5 : 3)} SOL`
              }
            >
              <span className={taxed ? 'font-semibold text-rose' : 'text-neutral-200'}>
                {quote.feeSolIsEstimate ? '≈ ' : ''}
                {usd(quote.feeSol)} · {quote.feePercent.toFixed(2)}%
              </span>
            </Row>
            <Row label="Max slippage">
              <span className="text-neutral-400">{DEFAULT_SLIPPAGE_PERCENT}%</span>
            </Row>
            {taxed && (
              <p className="pt-0.5 text-[11px] leading-relaxed text-rose/90">
                {coin.feePolicyVersion === 'bond-v1'
                  ? 'The 99% launch-slot guard drops to 1.25% from the next slot. Check the live quote before signing.'
                  : `The launch fee reduces toward ${BASE_FEE_PERCENT}%. Check the live quote before signing.`}
              </p>
            )}
          </>
        ) : (
          <p className="py-0.5 text-neutral-500">
            {loading
              ? 'Getting a quote…'
              : 'Enter an amount to see the trading fee before you confirm.'}
          </p>
        )}
      </dl>

      <Button
        ref={submitRef}
        className={cn(
          'h-11 w-full text-sm font-semibold',
          side === 'buy'
            ? 'bg-emerald text-ink hover:bg-emerald/90'
            : 'bg-rose text-white hover:bg-rose/90'
        )}
        disabled={!!publicKey && (!quote || sending || !!pendingTrade || short)}
        onClick={trade}
      >
        {!publicKey
          ? 'Connect wallet'
          : sending
            ? 'Confirm in your wallet…'
            : taxed
              ? `${side === 'buy' ? 'Buy' : 'Sell'} anyway (${quote!.feePercent.toFixed(0)}% tax)`
              : side === 'buy'
                ? `Buy ${coin.symbol}`
                : `Sell ${coin.symbol}`}
      </Button>
      {coin.isMigrated && (
        <p className="text-center text-[11px] text-neutral-500">
          Graduated · trades route to Meteora DAMM v2
        </p>
      )}
    </section>
  );
};

const presetClass =
  'h-8 rounded-md border border-neutral-850 font-mono text-[11px] text-neutral-400 transition-colors hover:border-neutral-700 hover:text-neutral-100 disabled:opacity-40 disabled:hover:border-neutral-850 disabled:hover:text-neutral-400';

const Row = ({
  label,
  labelClass,
  title,
  children,
}: React.PropsWithChildren<{ label: string; labelClass?: string; title?: string }>) => (
  <div className="flex items-center justify-between gap-3" title={title}>
    <dt className={labelClass ?? 'text-neutral-500'}>{label}</dt>
    <dd className="truncate text-right font-mono tabular-nums">{children}</dd>
  </div>
);

function useBalance(mint: string, wallet: string | undefined, enabled: boolean) {
  return useQuery<BalanceResponse>({
    queryKey: ['balance', mint, wallet],
    enabled: enabled && !!wallet,
    queryFn: async ({ signal }) => {
      const response = await fetch(
        `/api/coins/${encodeURIComponent(mint)}/balance?wallet=${encodeURIComponent(wallet!)}`,
        { signal }
      );
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Balance unavailable');
      return body;
    },
    refetchInterval: 15_000,
    retry: false,
  }).data;
}

function useQuote(mint: string, side: Side, amount: number) {
  const enabled = Number.isFinite(amount) && amount > 0;
  const query = useQuery<QuoteResponse>({
    queryKey: ['trade-quote', mint, side, amount],
    enabled,
    queryFn: async ({ signal }) => {
      const response = await fetch(
        `/api/quote?mint=${encodeURIComponent(mint)}&side=${side}&amount=${amount}`,
        {
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
            : AbortSignal.timeout(10_000),
        }
      );
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Quote unavailable. Try again shortly.');
      return body;
    },
    refetchInterval: 3000,
    retry: false,
    cacheTime: 0,
  });
  // A failed refresh must remove the previous quote and disable signing.
  const quote =
    enabled && !query.isError && Date.now() - query.dataUpdatedAt <= 5000
      ? (query.data ?? null)
      : null;
  return {
    quote,
    error: query.error instanceof Error ? query.error.message : null,
    loading: enabled && query.isFetching && !quote,
  };
}
