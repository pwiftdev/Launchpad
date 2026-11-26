import { shortenAddress } from '@/lib/utils';

/** A wallet shown by its address. The full address stays in the title for copying and checking. */
export function WalletIdentity({ wallet }: { wallet: string; compact?: boolean }) {
  return (
    <span
      data-private=""
      className="inline-flex min-w-0 max-w-full items-center gap-2"
      title={wallet}
    >
      <span className="min-w-0 truncate font-mono">{shortenAddress(wallet)}</span>
    </span>
  );
}
