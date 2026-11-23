import Link from 'next/link';
import { useCoinPanel } from '@/hooks/useCoinPanel';
import { usePrefetchCoin } from '@/hooks/useCoins';

type CoinLinkProps = React.PropsWithChildren<{
  mint: string;
  className?: string;
  'aria-label'?: string;
}>;

/**
 * Opens the coin panel in place (no page load) and warms its data on hover.
 * Cmd/Ctrl/middle-click still opens the full coin page in a new tab.
 */
export const CoinLink = ({ mint, className, children, ...rest }: CoinLinkProps) => {
  const { open } = useCoinPanel();
  const prefetch = usePrefetchCoin();

  return (
    <Link
      href={`/token/${mint}`}
      className={className}
      onMouseEnter={() => prefetch(mint)}
      onFocus={() => prefetch(mint)}
      onTouchStart={() => prefetch(mint)}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        open(mint);
      }}
      {...rest}
    >
      {children}
    </Link>
  );
};
