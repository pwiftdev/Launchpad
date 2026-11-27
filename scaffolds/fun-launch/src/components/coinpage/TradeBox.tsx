import { useEffect, useId, useRef, useState } from 'react';
import bs58 from 'bs58';
import { Transaction } from '@solana/web3.js';
import { useUnifiedWalletContext, useWallet } from '@jup-ag/wallet-adapter';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { BalanceResponse, Coin, QuoteResponse } from '@/lib/coin';
import { BASE_FEE_PERCENT, TOKEN_DECIMALS } from '@/constants/launch';
import { explorerUrl, NETWORK, NETWORK_LABEL } from '@/constants/network';
import { formatReadableNumber } from '@/lib/format/number';
import { useUsd } from '@/hooks/useUsd';
import { burstSparkles } from '@/lib/sparkles';
import { cn } from '@/lib/utils';
import { Button } from '../ui/button';
import { Segmented } from '../ui/Segmented';
import { CoinAvatar } from '../coin/CoinAvatar';
import { confirmTransaction } from '@/lib/confirmTransaction';
import { readTradeReceipt, tradeReceiptKey, type TradeReceipt } from '@/lib/tradeReceipt';
import { formatTokenUnits } from '@/lib/tokenUnits';
import { quoteAsset } from '@/lib/feeModes';
import { axiomLink } from '@/lib/axiom';
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
const REVIEW_QUOTE_MS = 20_000;

export const TradeBox = ({ coin, className }: { coin: Coin; className?: string }) => {
  const amountId = useId();
  const { publicKey, signTransaction } = useWallet();
  const { setShowModal } = useUnifiedWalletContext();
  const queryClient = useQueryClient();
  const [side, setSide] = useState<Side>('buy');
  const [amount, setAmount] = useState('');
  const [reviewRevision, setReviewRevision] = useState(0);
  const clearReview = () => setReviewRevision((revision) => revision + 1);
  const changeAmount = (value: string) => {
    if (value !== amount) {
      setAmount(value);
      clearReview();
    }
  };
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
  const { quote, error, loading, refetch, expiresAt } = useQuote(
    tradeKey,
    coin.mint,
    side,
    Number(amount),
    reviewRevision
  );
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
      if (!quote || quote.minimumAmountOut === '0' || Date.now() >= expiresAt) {
        clearReview();
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
          quotePool: quote.pool,
          minimumAmountOut: quote.minimumAmountOut,
        }),
      });
      const body = await res.json();
      if (res.status === 409) clearReview();
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
        clearReview();
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
          ['coin-prices', coin.mint],
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
      ['coin-prices', coin.mint],
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
      <section
        className={cn('flex flex-col gap-3 p-4', className)}
        aria-label="Preview trading unavailable"
      >
        <div className="pointer-events-none opacity-60">
          <Segmented
            label="Trade side"
            value="buy"
            onChange={() => {}}
            disabled
            stretch
            size="lg"
            toneFor={(id) => (id === 'buy' ? 'buy' : 'sell')}
            options={[
              { id: 'buy', label: 'Buy' },
              { id: 'sell', label: 'Sell' },
            ]}
          />
          <div className="well mt-3 rounded-2xl px-4 py-3.5">
            <p className="text-[11.5px] font-medium text-neutral-500">You pay</p>
            <p className="mt-1 font-mono text-[28px] font-medium tabular-nums text-neutral-700">
              0.00
            </p>
          </div>
        </div>
        <div className="tile flex items-start gap-3 p-3.5">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-primary/15 text-primary ring-1 ring-inset ring-primary/25">
            <span aria-hidden className="iconify h-4 w-4 ph--sparkle-fill" />
          </span>
          <div>
            <p className="text-sm font-semibold">Here for the looks</p>
            <p className="mt-1 text-xs leading-relaxed text-neutral-400">
              This is a sample coin for exploring the design. Its price, trades and holders are
              simulated.
            </p>
          </div>
        </div>
        <div className="flex h-12 items-center justify-center rounded-2xl border border-dashed border-white/10 text-[12.5px] text-neutral-500">
          Trading unavailable for samples
        </div>
      </section>
    );
  }

  if (
    !pendingTrade &&
    !coin.isMigrated &&
    coin.thresholdSol > 0 &&
    coin.quoteReserveSol >= coin.thresholdSol
  ) {
    return (
      <section className={cn('p-4 text-sm text-neutral-300', className)}>
        <span className="mb-3 grid h-10 w-10 place-items-center rounded-2xl bg-primary/15 text-primary ring-1 ring-inset ring-primary/30">
          <span aria-hidden className="iconify h-5 w-5 ph--graduation-cap-fill" />
        </span>
        <p className="text-[15px] font-semibold text-foreground">Ready to graduate</p>
        <p className="mt-1 text-xs leading-relaxed text-neutral-400">
          The curve reached its target. Complete the on-chain migration to resume trading on Meteora
          DAMM v2.
        </p>
        <Button className="mt-4 h-12 w-full rounded-2xl" disabled={sending} onClick={graduate}>
          {sending
            ? 'Confirming graduation…'
            : pendingMigration
              ? 'Check saved graduation'
              : 'Complete graduation'}
        </Button>
        <p className="mt-2 text-[11px] text-neutral-500">
          Your wallet shows network fees and any new-account rent before signing.
        </p>
        <AxiomTradeLink />
      </section>
    );
  }

  const numericAmount = Number(amount);
  const { symbol: quoteUnit } = quoteAsset(coin.quoteMint);
  const quoteToSol = coin.quoteToSol ?? 1;
  const quoteBalance = balance?.quoteBalance ?? (quoteUnit === 'SOL' ? balance?.sol : undefined);
  const available = side === 'buy' ? quoteBalance : balance?.tokens;
  const unit = side === 'buy' ? quoteUnit : coin.symbol;
  const short = available !== undefined && numericAmount > available;
  const canReview = Number.isFinite(numericAmount) && numericAmount > 0 && !short;
  const setFraction = (fraction: number) => {
    if (!balance) return;
    const value =
      side === 'buy'
        ? Math.max(
            0,
            (quoteBalance ?? 0) * fraction -
              (fraction === 1 && quoteUnit === 'SOL' ? BUY_SOL_RESERVE : 0)
          )
        : balance.tokens * fraction;
    const rounded = Math.floor(value * 1e6) / 1e6;
    changeAmount(rounded > 0 ? String(rounded) : '');
  };

  return (
    <section aria-label="Trade" className={cn('flex flex-col gap-3 p-4', className)}>
      {pendingTrade && (
        <div
          className="rounded-2xl border border-amber/25 bg-amber/[0.06] p-3.5 text-xs text-neutral-300"
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
                  changeAmount('');
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
        <div className="tile p-3 text-xs text-neutral-400">
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

      <Segmented
        role="tablist"
        label="Trade side"
        value={side}
        stretch
        size="lg"
        toneFor={(id) => (id === 'buy' ? 'buy' : 'sell')}
        disabled={sending || loading}
        className={cn((sending || loading) && 'opacity-70')}
        onChange={(s) => {
          if (sending || loading || s === side) return;
          setSide(s);
          setAmount('');
          clearReview();
        }}
        options={[
          { id: 'buy', label: 'Buy', icon: 'ph--arrow-down-left-bold' },
          { id: 'sell', label: 'Sell', icon: 'ph--arrow-up-right-bold' },
        ]}
      />

      <div
        className={cn(
          'well rounded-2xl px-4 pb-2.5 pt-3 transition-all duration-200 ease-out focus-within:border-primary/50 focus-within:shadow-[inset_0_1px_2px_rgba(0,0,0,0.35),0_0_0_4px_rgba(255,102,0,0.12)]',
          short && 'border-rose/50'
        )}
      >
        <div className="flex h-5 items-center justify-between text-[11px]">
          <label htmlFor={amountId} className="text-[11.5px] font-medium text-neutral-400">
            {side === 'buy' ? 'You pay' : 'You sell'}
          </label>
          {publicKey && (
            <button
              type="button"
              onClick={() => setFraction(1)}
              disabled={!balance || sending || loading}
              className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 font-mono text-neutral-400 transition-colors hover:bg-white/[0.06] hover:text-neutral-100 disabled:hover:bg-transparent disabled:hover:text-neutral-400"
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
        <div className="mt-1.5 flex items-center gap-2">
          <input
            id={amountId}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={amount}
            maxLength={24}
            disabled={sending || loading}
            onChange={(e) => {
              if (/^\d*(?:\.\d*)?$/.test(e.target.value)) changeAmount(e.target.value);
            }}
            className="min-w-0 flex-1 bg-transparent font-mono text-[28px] font-medium tracking-tight tabular-nums text-foreground outline-none placeholder:text-neutral-700"
          />
          <span className="flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-gradient-to-b from-white/[0.12] to-white/[0.04] pl-1 pr-3 text-[13px] font-semibold shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_4px_12px_-6px_rgba(0,0,0,0.9)] ring-1 ring-inset ring-white/10">
            {side === 'buy' ? (
              <span className="grid h-7 w-7 place-items-center rounded-full bg-gradient-to-br from-[#9945FF] to-[#14F195] text-[11px] font-bold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.4)]">
                ◎
              </span>
            ) : (
              <CoinAvatar
                image={coin.image}
                symbol={coin.symbol}
                className="h-7 w-7 rounded-full text-[10px]"
              />
            )}
            <span className="max-w-20 truncate">{unit}</span>
          </span>
        </div>
        <p className="mt-0.5 h-4 font-mono text-[11.5px] text-neutral-500">
          {short ? (
            <span className="text-rose">Insufficient balance</span>
          ) : side === 'buy' && price && numericAmount > 0 ? (
            `≈ ${usd(numericAmount * (coin.quoteToSol ?? 1))}`
          ) : null}
        </p>
      </div>

      <div className="grid grid-cols-4 gap-2">
        {side === 'buy'
          ? BUY_PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                disabled={sending || loading}
                onClick={() => changeAmount(String(p))}
                className={cn(
                  presetClass,
                  numericAmount === p &&
                    'border-emerald/40 bg-emerald/[0.12] text-emerald shadow-[0_0_16px_-6px_rgba(62,222,140,0.6)]'
                )}
              >
                {p} {quoteUnit}
              </button>
            ))
          : SELL_PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                disabled={!balance?.tokens || sending || loading}
                onClick={() => setFraction(p / 100)}
                className={presetClass}
              >
                {p === 100 ? 'Max' : `${p}%`}
              </button>
            ))}
      </div>

      {(loading || error || quote) && (
        <dl
          className={cn(
            'animate-in fade-in slide-in-from-top-1 space-y-2 rounded-2xl border px-4 py-3 text-xs duration-200',
            taxed ? 'border-rose/25 bg-rose/[0.08]' : 'border-white/[0.07] bg-white/[0.03]'
          )}
          aria-live="polite"
        >
          {error ? (
            <p className="text-rose">{error}</p>
          ) : quote ? (
            <>
              <Row label="You receive">
                <span className="font-semibold text-foreground">
                  {formatReadableNumber(quote.amountOut)} {side === 'buy' ? coin.symbol : quoteUnit}
                </span>
                {side === 'sell' && price && (
                  <span className="ml-1.5 text-neutral-500">
                    {usd(quote.amountOut * quoteToSol)}
                  </span>
                )}
              </Row>
              <Row
                label={taxed ? 'High launch fee' : 'Trading fee'}
                labelClass={taxed ? 'font-semibold text-rose' : undefined}
              >
                <span className={taxed ? 'font-semibold text-rose' : 'text-neutral-200'}>
                  {quote.feeSolIsEstimate ? '≈ ' : ''}
                  {quoteUnit === 'SOL'
                    ? usd(quote.feeSol)
                    : `${formatReadableNumber(quote.feeSol / quoteToSol)} ${quoteUnit}`}{' '}
                  · {quote.feePercent.toFixed(2)}%
                </span>
              </Row>
              <Row label="Minimum received">
                <span className="text-neutral-400">
                  {formatTokenUnits(
                    quote.minimumAmountOut,
                    side === 'buy' ? (coin.tokenDecimals ?? TOKEN_DECIMALS) : 9
                  )}{' '}
                  {side === 'buy' ? coin.symbol : quoteUnit}
                </span>
              </Row>
            </>
          ) : (
            <div className="space-y-2 py-0.5" aria-label="Getting a quote">
              <div className="skeleton h-3 w-3/4" />
              <div className="skeleton h-3 w-1/2" />
            </div>
          )}
        </dl>
      )}

      <Button
        ref={submitRef}
        className={cn(
          'h-12 w-full rounded-2xl text-[15px] font-semibold',
          !publicKey ? '' : side === 'buy' ? 'trade-buy' : 'trade-sell'
        )}
        disabled={!!publicKey && (!canReview || sending || loading || !!pendingTrade)}
        onClick={() => {
          if (!publicKey || !signTransaction) setShowModal(true);
          else if (quote) void trade();
          else void refetch();
        }}
      >
        {!publicKey
          ? 'Connect wallet'
          : loading
            ? 'Getting a quote…'
            : sending
              ? 'Confirm in your wallet…'
              : quote
                ? `Confirm ${side}`
                : `Review ${side}`}
      </Button>
      <AxiomTradeLink />
    </section>
  );
};

function AxiomTradeLink() {
  if (NETWORK !== 'mainnet-beta') return null;
  const affiliate = axiomLink();
  return (
    <a
      href={affiliate.href}
      target="_blank"
      rel={affiliate.referral ? 'sponsored noopener noreferrer' : 'noopener noreferrer'}
      className="block text-center text-xs text-neutral-400 transition-colors hover:text-primary"
    >
      Open Axiom ↗
      {affiliate.referral && <span className="ml-1 text-neutral-500">· Referral link</span>}
    </a>
  );
}

const presetClass =
  'h-9 rounded-full border border-white/[0.08] bg-white/[0.035] font-mono text-[11.5px] text-neutral-300 transition-all duration-200 ease-out hover:-translate-y-px hover:border-white/20 hover:bg-white/[0.07] hover:text-neutral-50 active:translate-y-0 active:scale-95 disabled:opacity-40 disabled:hover:translate-y-0 disabled:hover:border-white/[0.08] disabled:hover:bg-white/[0.035]';

const Row = ({
  label,
  labelClass,
  title,
  children,
}: React.PropsWithChildren<{ label: string; labelClass?: string; title?: string }>) => (
  <div className="flex items-center justify-between gap-3" title={title}>
    <dt className={labelClass ?? 'text-neutral-400'}>{label}</dt>
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
    staleTime: 60_000,
    retry: false,
  }).data;
}

function useQuote(tradeKey: string, mint: string, side: Side, amount: number, revision: number) {
  const [expiredAt, setExpiredAt] = useState(0);
  const query = useQuery<QuoteResponse>({
    queryKey: ['trade-quote', tradeKey, side, amount, revision],
    enabled: false,
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
      if (body.minimumAmountOut === '0') throw new Error('Enter a larger amount to trade.');
      return body;
    },
    retry: false,
    cacheTime: 0,
  });
  const expiresAt = query.dataUpdatedAt + REVIEW_QUOTE_MS;
  useEffect(() => {
    if (!query.dataUpdatedAt) return;
    const timer = setTimeout(() => setExpiredAt(expiresAt), Math.max(0, expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [query.dataUpdatedAt, expiresAt]);
  const quote =
    !query.isError &&
    query.data?.side === side &&
    query.data.amountIn === amount &&
    typeof query.data.minimumAmountOut === 'string' &&
    expiresAt !== expiredAt &&
    Date.now() < expiresAt
      ? query.data
      : null;
  return {
    quote,
    error: query.error instanceof Error ? query.error.message : null,
    loading: query.isFetching,
    expiresAt,
    refetch: query.refetch,
  };
}
