import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { useCoinPanel } from '@/hooks/useCoinPanel';
import { prefetchCoin } from '@/hooks/useCoins';

/** A pointer that rests this long means intent; passing over a row on the way elsewhere doesn't. */
const HOVER_INTENT_MS = 70;

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
  const client = useQueryClient();
  const intent = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(intent.current), [mint]);
  const warm = () => prefetchCoin(client, mint);
  const cancel = () => clearTimeout(intent.current);

  return (
    <Link
      href={`/token/${mint}`}
      className={className}
      prefetch={false}
      onPointerEnter={(e) => {
        if (e.pointerType !== 'mouse') return;
        cancel();
        intent.current = setTimeout(warm, HOVER_INTENT_MS);
      }}
      onPointerLeave={cancel}
      onPointerDown={warm}
      onFocus={warm}
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
