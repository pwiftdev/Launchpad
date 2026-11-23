import { useCallback, useEffect, useRef, useState } from 'react';
import { useUnifiedWalletContext, useWallet } from '@jup-ag/wallet-adapter';
import { useWalletProfiles } from '@/hooks/useWalletProfiles';
import {
  messageSignature,
  assertSocialChallenge,
  mergeCallouts,
  socialRequest,
  type Callout,
  type SocialChallenge,
} from '@/lib/profiles';
import { WalletIdentity } from './WalletIdentity';

export function TokenCallouts({ mint }: { mint: string }) {
  return <Callouts key={mint} mint={mint} />;
}
function Callouts({ mint }: { mint: string }) {
  const { publicKey, signMessage } = useWallet();
  const { setShowModal } = useUnifiedWalletContext();
  const wallet = publicKey?.toBase58();
  const active = useRef(wallet);
  active.current = wallet;
  const [rows, setRows] = useState<Callout[]>([]),
    [before, setBefore] = useState<string | null>(null),
    [body, setBody] = useState('');
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const feed = useRef<HTMLDivElement>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const requests = useRef<{ head: AbortController | null; older: AbortController | null }>({
    head: null,
    older: null,
  });
  const [newRows, setNewRows] = useState<Callout[]>([]);
  const { profiles } = useWalletProfiles(rows.map((row) => row.wallet));
  const load = useCallback(
    async (cursor?: string, background = false) => {
      const kind = cursor ? 'older' : 'head';
      if (background && requests.current.head) return;
      requests.current[kind]?.abort();
      const controller = new AbortController();
      requests.current[kind] = controller;
      if (!background) {
        setLoading(true);
        setError(null);
      }
      try {
        const response = await fetch(
          `/api/callouts?mint=${encodeURIComponent(mint)}${cursor ? `&before=${cursor}` : ''}`,
          { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)]) }
        );
        const data = (await response.json()) as {
          callouts: Callout[];
          nextBefore: string | null;
          error?: string;
        };
        if (!response.ok) throw new Error(data.error || 'Unable to load callouts.');
        if (!mounted.current || controller.signal.aborted) return;
        if (!cursor && background && (feed.current?.scrollTop ?? 0) > 24) {
          setNewRows(
            data.callouts.filter((row) => !rowsRef.current.some((old) => old.id === row.id))
          );
        } else {
          setRows((old) => mergeCallouts(old, data.callouts));
          if (!cursor) setNewRows([]);
        }
        if (cursor || !rowsRef.current.length) setBefore(data.nextBefore);
      } catch (err) {
        if (mounted.current && !controller.signal.aborted && !background)
          setError(err instanceof Error ? err.message : 'Unable to load callouts.');
      } finally {
        if (mounted.current && !controller.signal.aborted && !background) setLoading(false);
        if (requests.current[kind] === controller) requests.current[kind] = null;
      }
    },
    [mint]
  );
  useEffect(() => {
    mounted.current = true;
    const activeRequests = requests.current;
    void load();
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load(undefined, true);
    }, 10_000);
    return () => {
      mounted.current = false;
      window.clearInterval(interval);
      activeRequests.head?.abort();
      activeRequests.older?.abort();
    };
  }, [load]);
  async function post(event: React.FormEvent) {
    event.preventDefault();
    if (!wallet) return setShowModal(true);
    if (!signMessage || busy || !body.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const challenge = (await socialRequest('/api/callouts', {
        action: 'challenge',
        wallet,
        payload: { mint, body },
      })) as SocialChallenge;
      assertSocialChallenge(challenge, window.location.origin, wallet, 'callout', { mint, body });
      if (active.current !== wallet || !mounted.current)
        throw new Error('Wallet changed. Try again.');
      const signature = messageSignature(
        await signMessage(new TextEncoder().encode(challenge.message))
      );
      if (active.current !== wallet || !mounted.current)
        throw new Error('Wallet changed. Try again.');
      await socialRequest('/api/callouts', {
        action: 'submit',
        wallet,
        nonce: challenge.nonce,
        signature,
      });
      if (mounted.current) {
        setBody('');
        await load();
      }
    } catch (err) {
      if (mounted.current)
        setError(
          err instanceof Error
            ? err.message
            : 'Unable to post. Refresh to check before trying again.'
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <section aria-label="Token callouts" className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold">Community callouts</h3>
          <p className="mt-1 text-xs text-neutral-500">
            Ideas, updates and discussion from wallet owners. Not verified advice.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="text-xs text-primary"
        >
          Refresh
        </button>
      </div>
      <form onSubmit={post} className="space-y-2">
        <label className="sr-only" htmlFor={`callout-${mint}`}>
          Your callout
        </label>
        <textarea
          id={`callout-${mint}`}
          value={body}
          maxLength={500}
          rows={3}
          onChange={(e) => setBody(e.target.value)}
          placeholder="What should other holders know?"
          className="w-full resize-y rounded-xl border border-neutral-800 bg-background p-3 text-sm outline-none focus:border-primary"
        />
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-neutral-500">
            {body.length}/500 · Signed message, no transaction
          </span>
          <button
            disabled={busy || (!!wallet && (!signMessage || !body.trim()))}
            className="rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-950 disabled:opacity-50"
          >
            {busy ? 'Confirm in wallet…' : wallet ? 'Sign & post' : 'Connect to post'}
          </button>
        </div>
      </form>
      {error && (
        <p role="alert" className="text-xs text-rose">
          {error}
        </p>
      )}
      {!rows.length && !loading && !error && (
        <p className="py-5 text-center text-sm text-neutral-500">Start the conversation.</p>
      )}
      {newRows.length > 0 && (
        <button
          type="button"
          className="w-full rounded-lg bg-primary/10 py-2 text-xs text-primary"
          onClick={() => {
            setRows((old) => mergeCallouts(old, newRows));
            setNewRows([]);
            feed.current?.scrollTo({ top: 0, behavior: 'smooth' });
          }}
        >
          Show {newRows.length} new callouts
        </button>
      )}
      <div ref={feed} className="max-h-[32rem] space-y-4 overflow-y-auto">
        {rows.map((row) => (
          <article key={row.id} className="border-t border-neutral-850 pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <WalletIdentity wallet={row.wallet} profile={profiles[row.wallet]} />
              <time dateTime={row.created_at} className="text-[10px] text-neutral-500">
                {new Date(row.created_at).toLocaleString()}
              </time>
            </div>
            <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-neutral-300">
              {row.body}
            </p>
          </article>
        ))}
      </div>
      {loading && (
        <p role="status" className="text-xs text-neutral-500">
          Loading callouts…
        </p>
      )}
      {before && rows.length < 200 && (
        <button
          disabled={loading}
          onClick={() => void load(before)}
          className="w-full rounded-lg border border-neutral-800 py-2 text-xs"
        >
          Load earlier callouts
        </button>
      )}
    </section>
  );
}
