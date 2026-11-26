import Link from 'next/link';
import { useCoinPanel } from '@/hooks/useCoinPanel';

type CoinLinkProps = React.PropsWithChildren<{
  mint: string;
  className?: string;
  'aria-label'?: string;
  title?: string;
}>;

/**
 * Opens the coin panel in place.
 * Cmd/Ctrl/middle-click still opens the full coin page in a new tab.
 */
export const CoinLink = ({ mint, className, children, ...rest }: CoinLinkProps) => {
  const { open } = useCoinPanel();

  return (
    <Link
      href={`/token/${mint}`}
      className={className}
      prefetch={false}
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
