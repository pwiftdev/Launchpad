import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useUnifiedWalletContext, useWallet } from '@jup-ag/wallet-adapter';
import { useQuery } from '@tanstack/react-query';
import {
  assertSocialChallenge,
  messageSignature,
  socialRequest,
  type SocialChallenge,
} from '@/lib/profiles';
import { CHAT_MESSAGE_MAX, type ChatFeed, type ChatMessage } from '@/lib/tokenChat';
import { cn } from '@/lib/utils';
import { Button } from '../ui/button';

const ENDPOINT = '/api/token-chat';
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

async function readChat(mint: string, wallet: string, signal?: AbortSignal, before?: string) {
  const params = new URLSearchParams({ mint });
  if (before) params.set('before', before);
  const timeout = AbortSignal.timeout(8_000);
  const response = await fetch(`${ENDPOINT}?${params}`, {
    headers: { 'X-Chat-Wallet': wallet },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (response.status === 401) return null;
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Chat is temporarily unavailable.');
  return result as ChatFeed;
}

export function TokenChatRoom({ mint, symbol }: { mint: string; symbol: string }) {
  const wallet = useWallet().publicKey?.toBase58();
  return <Room key={`${mint}:${wallet ?? ''}`} mint={mint} symbol={symbol} wallet={wallet} />;
}

function Room({ mint, symbol, wallet }: { mint: string; symbol: string; wallet?: string }) {
  const { signMessage } = useWallet();
  const { setShowModal } = useUnifiedWalletContext();
  const [body, setBody] = useState('');
  const [history, setHistory] = useState<ChatFeed>();
  const [issue, setIssue] = useState('');
  const [working, setWorking] = useState(false);
  const active = useRef(true);
  const action = useRef(false);
  const retry = useRef<string | undefined>(undefined);
  const timeline = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const title = useId();
  const composer = useId();
  const chat = useQuery({
    queryKey: [ENDPOINT, mint, wallet],
    queryFn: ({ signal }) => readChat(mint, wallet!, signal),
    enabled: !!wallet,
    refetchInterval: (data) => (data ? 5_000 : false),
    retry: false,
    cacheTime: 0,
  });
  const feed = chat.data;
  const messages = feed
    ? [
        ...new Map(
          [...(history?.messages ?? []), ...feed.messages].map((row) => [row.id, row])
        ).values(),
      ]
    : [];
  const before = history ? history.nextBefore : feed?.nextBefore;
  const lastId = messages.at(-1)?.id;
  const error = issue || (chat.error instanceof Error ? chat.error.message : '');

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    if (atBottom.current && timeline.current)
      timeline.current.scrollTop = timeline.current.scrollHeight;
  }, [lastId]);
  useEffect(() => {
    if (feed === null) {
      setHistory(undefined);
      atBottom.current = true;
    }
  }, [feed]);

  async function run(operation: () => Promise<void>) {
    if (action.current) return;
    action.current = true;
    setWorking(true);
    setIssue('');
    try {
      await operation();
    } catch (error) {
      if (active.current)
        setIssue(error instanceof Error ? error.message : 'Chat is temporarily unavailable.');
    } finally {
      action.current = false;
      if (active.current) setWorking(false);
    }
  }

  function join() {
    if (!wallet) return setShowModal(true);
    if (!signMessage) return;
    void run(async () => {
      const challenge = (await socialRequest(ENDPOINT, {
        action: 'challenge',
        mint,
        wallet,
      })) as SocialChallenge;
      assertSocialChallenge(challenge, window.location.origin, wallet, 'chat', { mint });
      if (!active.current) return;
      const signature = messageSignature(
        await signMessage(new TextEncoder().encode(challenge.message))
      );
      if (!active.current) return;
      await socialRequest(ENDPOINT, { action: 'join', wallet, nonce: challenge.nonce, signature });
      if (active.current) await chat.refetch();
    });
  }

  function post(event: FormEvent) {
    event.preventDefault();
    if (!wallet || !feed || !body.trim()) return;
    void run(async () => {
      const clientId = (retry.current ??= crypto.randomUUID());
      await socialRequest(
        ENDPOINT,
        { action: 'post', mint, clientId, body },
        { 'X-Chat-Wallet': wallet }
      );
      if (!active.current) return;
      retry.current = undefined;
      setBody('');
      atBottom.current = true;
      await chat.refetch();
    });
  }

  function earlier() {
    if (!wallet || !before) return;
    void run(async () => {
      const page = await readChat(mint, wallet, undefined, before);
      if (!active.current) return;
      if (!page) {
        await chat.refetch();
        return;
      }
      atBottom.current = false;
      setHistory((current) => ({
        ...page,
        messages: [...page.messages, ...(current?.messages ?? [])],
      }));
    });
  }

  return (
    <section aria-labelledby={title} className="order-2 bg-neutral-950 px-4 py-4">
      <div className="overflow-hidden rounded-xl border border-white/10 bg-neutral-925">
        <div className="flex items-center justify-between gap-2 border-b border-white/10 px-3 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
              <span aria-hidden="true" className="iconify h-5 w-5 ph--chats-circle" />
            </div>
            <div className="min-w-0">
              <h2 id={title} className="truncate text-sm font-semibold">
                ${symbol} chat
              </h2>
              <p className="flex items-center gap-1 text-[11px] text-neutral-400">
                <span aria-hidden="true" className="iconify h-3 w-3 ph--lock-simple" />
                Wallet access · Encrypted storage
              </p>
            </div>
          </div>
          {feed && (
            <button
              type="button"
              disabled={working}
              className="text-xs text-neutral-400 hover:text-foreground"
              onClick={() =>
                void run(async () => {
                  await socialRequest(ENDPOINT, { action: 'leave' });
                  if (active.current) {
                    setBody('');
                    retry.current = undefined;
                    await chat.refetch();
                  }
                })
              }
            >
              Leave
            </button>
          )}
        </div>
        {feed ? (
          <>
            <div
              ref={timeline}
              role="log"
              aria-label="Chat messages"
              tabIndex={0}
              onScroll={(event) => {
                const target = event.currentTarget;
                atBottom.current =
                  target.scrollHeight - target.clientHeight - target.scrollTop < 48;
              }}
              className="h-60 space-y-3 overflow-y-auto overscroll-contain px-3 py-3 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary"
            >
              {before && (
                <button
                  onClick={earlier}
                  type="button"
                  disabled={working}
                  className="mx-auto block py-1 text-xs text-primary disabled:opacity-50"
                >
                  Load earlier messages
                </button>
              )}
              {messages.length ? (
                messages.map((message) => (
                  <ChatBubble
                    key={message.id}
                    message={message}
                    own={message.author === feed.viewer}
                  />
                ))
              ) : (
                <p className="pt-12 text-center text-xs text-neutral-400">
                  Start the conversation.
                </p>
              )}
            </div>
            <form onSubmit={post} className="flex items-end gap-2 border-t border-white/10 p-3">
              <label htmlFor={composer} className="sr-only">
                Message
              </label>
              <textarea
                id={composer}
                rows={2}
                disabled={working}
                maxLength={CHAT_MESSAGE_MAX}
                placeholder="Write a message"
                value={body}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing)
                    return;
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }}
                onChange={(event) => {
                  retry.current = undefined;
                  setBody(event.target.value);
                }}
                className="min-w-0 flex-1 resize-y rounded-lg border border-white/10 bg-neutral-950 px-2.5 py-2 text-sm text-foreground outline-none placeholder:text-neutral-500 focus:border-primary"
              />
              <Button size="sm" type="submit" disabled={working || !body.trim()}>
                Send
              </Button>
            </form>
          </>
        ) : (
          <div className="px-3 py-6 text-center">
            <p className="mb-3 text-xs text-neutral-400">
              {wallet && chat.isFetching
                ? 'Checking chat access…'
                : 'Join with a wallet signature to read and post.'}
            </p>
            <Button
              size="sm"
              type="button"
              onClick={join}
              disabled={working || (!!wallet && (!signMessage || chat.isFetching))}
            >
              {working ? 'Check your wallet…' : wallet ? 'Sign in to chat' : 'Connect wallet'}
            </Button>
            {wallet && !signMessage && (
              <p className="mt-2 text-xs text-neutral-400">Use a wallet that can sign messages.</p>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="px-3 pb-3 text-xs text-rose">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}

function ChatBubble({ message, own }: { message: ChatMessage; own: boolean }) {
  return (
    <div className={cn('max-w-[92%]', own && 'ml-auto')}>
      <div className={cn('mb-1 flex gap-2 text-[11px] text-neutral-400', own && 'justify-end')}>
        <span className={own ? 'text-primary' : 'font-mono'}>
          {own ? 'You' : `Wallet ${message.author.slice(0, 8)}`}
        </span>
        <time dateTime={message.createdAt}>{timeFormat.format(new Date(message.createdAt))}</time>
      </div>
      <p
        className={cn(
          'break-words whitespace-pre-wrap rounded-lg px-2.5 py-2 text-sm text-foreground',
          own ? 'bg-primary/10' : 'bg-white/5'
        )}
      >
        {message.body}
      </p>
    </div>
  );
}
