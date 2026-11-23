import type { Holder, Trade } from './coin';
import { tradeValueSol } from './pot';

export type TraderActivity = {
  wallet: string;
  buys: number;
  sells: number;
  boughtSol: number;
  soldSol: number;
  volumeSol: number;
  lastActive: number;
};

/** Observed cash flow only. A short trade tape cannot establish a wallet's cost basis or P&L. */
export function rankTraders(trades: readonly Trade[]): TraderActivity[] {
  const seen = new Set<string>();
  const wallets = new Map<string, TraderActivity>();
  for (const trade of trades) {
    const id = trade.id ?? `${trade.sig}:${trade.instructionIndex ?? 0}:${trade.eventIndex ?? 0}`;
    if (
      seen.has(id) ||
      !Number.isFinite(trade.sol) ||
      trade.sol < 0 ||
      !Number.isFinite(trade.feeSol) ||
      trade.feeSol < 0 ||
      !Number.isFinite(trade.ts)
    )
      continue;
    seen.add(id);
    const item = wallets.get(trade.wallet) ?? {
      wallet: trade.wallet,
      buys: 0,
      sells: 0,
      boughtSol: 0,
      soldSol: 0,
      volumeSol: 0,
      lastActive: 0,
    };
    if (trade.side === 'buy') {
      item.buys++;
      item.boughtSol += trade.sol;
    } else {
      item.sells++;
      item.soldSol += trade.sol;
    }
    item.volumeSol += tradeValueSol(trade);
    item.lastActive = Math.max(item.lastActive, trade.ts);
    wallets.set(trade.wallet, item);
  }
  return [...wallets.values()].sort(
    (a, b) => b.volumeSol - a.volumeSol || a.wallet.localeCompare(b.wallet)
  );
}

export function holderSupplyShare(holder: Holder, tokenSupply: number | undefined): number | null {
  const share =
    holder.shareOfSupply ??
    (tokenSupply !== undefined && tokenSupply > 0 ? holder.amount / tokenSupply : undefined);
  return typeof share === 'number' && Number.isFinite(share) && share >= 0 && share <= 1
    ? share
    : null;
}

export function displayShare(share: number | null): string {
  if (share === null) return '—';
  return share > 0 && share < 0.0001 ? '<0.01%' : `${(share * 100).toFixed(2)}%`;
}
