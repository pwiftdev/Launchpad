import { useRef, useState } from 'react';
import { Dialog } from 'radix-ui';
import { useWallet } from '@jup-ag/wallet-adapter';
import { useWalletProfiles, refreshWalletProfiles } from '@/hooks/useWalletProfiles';
import {
  messageSignature,
  assertSocialChallenge,
  socialRequest,
  type WalletProfile,
  type ProfileDraft,
  type SocialChallenge,
} from '@/lib/profiles';
import { WalletIdentity, ProfileAvatar } from './WalletIdentity';

const inputClass =
  'w-full rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm outline-none focus:border-primary';
export function ProfileEditorButton({ compact = false }: { compact?: boolean }) {
  const { publicKey } = useWallet();
  const wallet = publicKey?.toBase58();
  const [open, setOpen] = useState(false);
  const { profiles, loading, error, refresh } = useWalletProfiles(wallet ? [wallet] : []);
  if (!wallet) return null;
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger
        className={
          compact
            ? 'inline-flex h-9 w-9 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-neutral-800 text-xs hover:border-primary/50 sm:w-auto sm:px-3'
            : 'rounded-lg border border-neutral-800 px-3 py-2 text-xs hover:border-primary/50'
        }
        aria-label="Edit your wallet profile"
      >
        {compact && <span className="iconify h-4 w-4 ph--user-circle" />}
        <span className={compact ? 'hidden sm:inline' : undefined}>Profile</span>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[61] max-h-[90dvh] w-[calc(100%_-_2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-2xl border border-neutral-800 bg-background p-6 shadow-xl">
          <div className="mb-2 flex items-center justify-between">
            <Dialog.Title className="font-term text-xl font-semibold uppercase tracking-tight">Your alias</Dialog.Title>
            <Dialog.Close aria-label="Close profile" className="rounded px-2 py-1 text-neutral-400">
              ×
            </Dialog.Close>
          </div>
          <Dialog.Description className="mb-5 text-xs leading-relaxed text-neutral-400">
            Choose how you appear in the community. Your wallet address always stays visible. A name
            is not an endorsement.
          </Dialog.Description>
          {loading ? (
            <p className="text-sm text-neutral-400">Loading profile…</p>
          ) : error ? (
            <div>
              <p role="alert">{error}</p>
              <button onClick={refresh} className="mt-3 text-primary">
                Try again
              </button>
            </div>
          ) : (
            <ProfileForm
              key={`${wallet}:${profiles[wallet]?.updated_at ?? 'new'}`}
              wallet={wallet}
              profile={profiles[wallet]}
            />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
function ProfileForm({ wallet, profile }: { wallet: string; profile?: WalletProfile }) {
  const { publicKey, signMessage } = useWallet();
  const active = useRef(publicKey?.toBase58());
  active.current = publicKey?.toBase58();
  const [draft, setDraft] = useState<ProfileDraft>({
    username: profile?.username ?? '',
    bio: profile?.bio ?? '',
    avatarUrl: profile?.avatar_url ?? '',
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [saved, setSaved] = useState(false);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!signMessage || busy) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const challenge = (await socialRequest('/api/profiles', {
        action: 'challenge',
        wallet,
        payload: draft,
      })) as SocialChallenge;
      assertSocialChallenge(challenge, window.location.origin, wallet, 'profile', draft);
      if (active.current !== wallet) throw new Error('Wallet changed. Reopen your profile.');
      const signature = messageSignature(
        await signMessage(new TextEncoder().encode(challenge.message))
      );
      if (active.current !== wallet) throw new Error('Wallet changed. Reopen your profile.');
      await socialRequest('/api/profiles', {
        action: 'submit',
        wallet,
        nonce: challenge.nonce,
        signature,
      });
      setSaved(true);
      refreshWalletProfiles();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to save your profile.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={save} className="space-y-4">
      <div className="flex items-center gap-3">
        <ProfileAvatar wallet={wallet} profile={profile} />
        <WalletIdentity wallet={wallet} compact profile={profile} />
      </div>
      <label className="block space-y-1.5 text-xs text-neutral-400">
        <span>Username</span>
        <input
          required
          value={draft.username}
          minLength={3}
          maxLength={24}
          pattern="[A-Za-z][A-Za-z0-9_]{2,23}"
          onChange={(e) => setDraft({ ...draft, username: e.target.value })}
          className={inputClass}
          autoComplete="off"
        />
        <span className="block text-[10px]">
          3–24 letters, numbers or underscores. Starts with a letter.
        </span>
      </label>
      <label className="block space-y-1.5 text-xs text-neutral-400">
        <span>Bio</span>
        <textarea
          value={draft.bio}
          maxLength={280}
          rows={3}
          onChange={(e) => setDraft({ ...draft, bio: e.target.value })}
          className={inputClass}
        />
        <span className="block text-right text-[10px]">{draft.bio.length}/280</span>
      </label>
      <label className="block space-y-1.5 text-xs text-neutral-400">
        <span>Avatar URL · optional</span>
        <input
          type="url"
          value={draft.avatarUrl}
          maxLength={500}
          onChange={(e) => setDraft({ ...draft, avatarUrl: e.target.value })}
          className={inputClass}
          placeholder="https://ipfs.io/ipfs/…"
        />
        <span className="block text-[10px]">
          HTTPS images from ipfs.io, arweave.net or images.unsplash.com. Leave empty for initials.
        </span>
      </label>
      {error && (
        <p role="alert" className="text-sm text-rose">
          {error}
        </p>
      )}
      {saved && (
        <p role="status" className="text-sm text-emerald">
          Profile saved.
        </p>
      )}
      <button
        disabled={busy || !signMessage}
        type="submit"
        className="w-full rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-950 disabled:opacity-50"
      >
        {busy
          ? 'Confirm the message in your wallet…'
          : signMessage
            ? 'Sign message to save'
            : 'This wallet cannot sign messages'}
      </button>
      <p className="text-center text-[10px] text-neutral-500">
        Message signature only. No transaction or wallet permissions.
      </p>
    </form>
  );
}
