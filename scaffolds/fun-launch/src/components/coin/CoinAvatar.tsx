import { useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { tokenImageSources } from '@/lib/ipfs';

type CoinAvatarProps = {
  image: string | null;
  symbol: string;
  className?: string;
};

// Coins without an image get a quiet monogram tile; the ticker letter carries it.

export const CoinAvatar = (props: CoinAvatarProps) => (
  <AvatarImage key={props.image ?? props.symbol} {...props} />
);

const AvatarImage = ({ image, symbol, className }: CoinAvatarProps) => {
  const sources = useMemo(() => (image ? tokenImageSources(image) : []), [image]);
  const [attempt, setAttempt] = useState(0);
  const [loadedSource, setLoadedSource] = useState<string | null>(null);
  const src = sources[attempt];
  useEffect(() => {
    if (!image || (src && loadedSource === src)) return;
    // A gateway can hang without firing onError. Keep initials visible and try its equivalent.
    const timer = setTimeout(
      () => setAttempt((current) => (src ? current + 1 : 0)),
      src ? 10_000 : 30_000
    );
    return () => clearTimeout(timer);
  }, [image, src, loadedSource]);

  return (
    <div
      role="img"
      aria-label={`${symbol} token image`}
      className={cn(
        'relative flex shrink-0 items-center justify-center overflow-hidden rounded-xl bg-neutral-900 font-term font-semibold text-neutral-300 ring-1 ring-inset ring-neutral-800',
        className
      )}
    >
      {symbol.slice(0, 1).toUpperCase()}
      {src && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={src}
          src={src}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onLoad={() => setLoadedSource(src)}
          onError={() => setAttempt((current) => current + 1)}
          className={cn(
            'absolute inset-0 h-full w-full object-cover transition-opacity',
            loadedSource === src ? 'opacity-100' : 'opacity-0'
          )}
        />
      )}
    </div>
  );
};
