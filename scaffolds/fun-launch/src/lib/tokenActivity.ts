import type { Holder } from './coin';

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
