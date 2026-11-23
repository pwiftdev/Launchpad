import { useState } from 'react';
import type { WalletProfile } from '@/lib/profiles';
import { safeAvatarUrl } from '@/lib/profiles';
import { shortenAddress } from '@/lib/utils';

export function ProfileAvatar({ profile, wallet }: { profile?: WalletProfile; wallet: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  const url = profile?.avatar_url;
  return (
    <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full border border-primary/20 bg-primary/10 text-[10px] font-semibold uppercase text-primary">
      {url && safeAvatarUrl(url) && failed !== url ? (
        // Approved HTTPS avatar hosts only; no server-side fetching or cookies.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt=""
          width={28}
          height={28}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(url)}
          className="h-full w-full object-cover"
        />
      ) : (
        (profile?.username ?? wallet).slice(0, 2)
      )}
    </span>
  );
}

/** Receives a batched identity; never makes a request per cell. Wallet remains the source of identity. */
export function WalletIdentity({
  wallet,
  profile,
  compact = false,
}: {
  wallet: string;
  profile?: WalletProfile;
  compact?: boolean;
}) {
  const matching = profile?.wallet === wallet ? profile : undefined;
  return (
    <span
      data-private=""
      className="inline-flex min-w-0 max-w-full items-center gap-2"
      title={`${wallet}${matching?.bio ? ` · ${matching.bio}` : ''}`}
    >
      {!compact && <ProfileAvatar profile={matching} wallet={wallet} />}
      <span className="min-w-0 truncate">
        <span className={matching ? 'font-medium' : 'font-mono'}>
          {matching ? `@${matching.username}` : shortenAddress(wallet)}
        </span>
        {matching && !compact && (
          <span className="ml-1.5 font-mono text-[10px] text-neutral-500">
            {shortenAddress(wallet)}
          </span>
        )}
      </span>
    </span>
  );
}
