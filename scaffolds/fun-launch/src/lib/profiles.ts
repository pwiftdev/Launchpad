export type WalletProfile = {
  wallet: string;
  username: string;
  bio: string;
  avatar_url: string;
  updated_at: string;
};
export type ProfileDraft = { username: string; bio: string; avatarUrl: string };
export type Callout = { id: string; wallet: string; body: string; created_at: string };
export type SocialChallenge = { nonce: string; message: string; expiresAt: string };
export type SocialPurpose = 'profile' | 'callout' | 'chat' | 'launch-preview' | 'otc';
export function mergeCallouts(current: Callout[], incoming: Callout[]): Callout[] {
  return [...new Map([...current, ...incoming].map((row) => [row.id, row])).values()]
    .sort((a, b) => (BigInt(a.id) > BigInt(b.id) ? -1 : BigInt(a.id) < BigInt(b.id) ? 1 : 0))
    .slice(0, 200);
}

export function socialMessage(
  origin: string,
  wallet: string,
  purpose: SocialPurpose,
  payload: unknown,
  nonce: string,
  expiresAt: string
) {
  return [
    purpose === 'otc'
      ? 'MSKD.fun · Sign in to confidential OTC'
      : purpose === 'launch-preview'
        ? 'MSKD.fun · Sign in to private launch previews'
        : purpose === 'chat'
          ? 'MSKD.fun · Sign in to token chat'
          : 'plzzz.bond · Wallet profile and callouts',
    `Site: ${origin}`,
    `Wallet: ${wallet}`,
    `Action: ${purpose}`,
    `Content: ${JSON.stringify(payload)}`,
    `Nonce: ${nonce}`,
    `Expires: ${expiresAt}`,
    purpose === 'otc'
      ? 'This message only opens an OTC session. It cannot move funds.'
      : purpose === 'launch-preview'
        ? 'This message only opens a private preview session. It cannot move funds.'
        : purpose === 'chat'
          ? 'This message only opens a chat session. It cannot move funds.'
          : 'This message only updates your public profile or posts a callout. It cannot move funds.',
  ].join('\n');
}

/** Never hand arbitrary server text to a wallet's signMessage method. */
export function assertSocialChallenge(
  challenge: SocialChallenge,
  origin: string,
  wallet: string,
  purpose: SocialPurpose,
  draft: ProfileDraft | { mint: string; body?: string } | null,
  now = Date.now()
) {
  const expires = Date.parse(challenge.expiresAt);
  if (
    !/^[a-f0-9]{64}$/.test(challenge.nonce) ||
    !Number.isFinite(expires) ||
    expires <= now ||
    expires > now + 330_000 ||
    typeof challenge.message !== 'string' ||
    challenge.message.length > 2400
  )
    throw new Error('Invalid or expired wallet message. Please try again.');
  let payload: object;
  if (purpose === 'profile' && draft && 'username' in draft) {
    payload = {
      username: draft.username.trim().toLowerCase(),
      bio: draft.bio.trim(),
      avatarUrl: draft.avatarUrl,
    };
  } else if (
    purpose === 'otc' ||
    purpose === 'launch-preview' ||
    (draft && 'mint' in draft && (purpose === 'chat' || purpose === 'callout'))
  ) {
    const content = challenge.message.split('\n')[4];
    let parsed: unknown;
    try {
      parsed = JSON.parse(content?.slice('Content: '.length) ?? '');
    } catch {
      throw new Error('Invalid wallet message.');
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !('networkGenesis' in parsed) ||
      typeof parsed.networkGenesis !== 'string' ||
      !/^[A-Za-z0-9]{32,64}$/.test(parsed.networkGenesis)
    )
      throw new Error('Invalid wallet network.');
    payload = { networkGenesis: parsed.networkGenesis };
    if ((purpose === 'chat' || purpose === 'callout') && draft && 'mint' in draft) {
      payload = { ...payload, mint: draft.mint };
    }
    if (purpose === 'callout' && draft && 'mint' in draft) {
      if (typeof draft.body !== 'string') throw new Error('Invalid message content.');
      payload = { ...payload, body: draft.body.trim() };
    }
  } else throw new Error('Invalid message action.');
  if (
    challenge.message !==
    socialMessage(origin, wallet, purpose, payload, challenge.nonce, challenge.expiresAt)
  )
    throw new Error('Wallet message does not match your request.');
}

export const AVATAR_HOSTS = ['images.unsplash.com', 'ipfs.io', 'arweave.net'] as const;
export function safeAvatarUrl(value: string): boolean {
  if (value === '') return true;
  try {
    const url = new URL(value);
    return (
      value.length <= 500 &&
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.hash &&
      !url.port &&
      (AVATAR_HOSTS as readonly string[]).includes(url.hostname)
    );
  } catch {
    return false;
  }
}

export class SocialRequestError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

export async function socialRequest(
  path:
    | '/api/profiles'
    | '/api/callouts'
    | '/api/token-chat'
    | '/api/launch-previews'
    | '/api/otc'
    | '/api/otc-rings',
  body: object,
  headers?: Record<string, string>,
  signal?: AbortSignal
) {
  const timeout = AbortSignal.timeout(20_000);
  const response = await fetch(path, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
  });
  const result = await response.json().catch((): null => null);
  if (!response.ok)
    throw new SocialRequestError(
      result?.error || 'Request failed. Please try again.',
      response.status
    );
  if (!result) throw new Error('Request failed. Please try again.');
  return result;
}

export function messageSignature(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
}

export async function unlockPrivateSession(
  path: '/api/launch-previews' | '/api/otc',
  purpose: 'launch-preview' | 'otc',
  wallet: string,
  signMessage: (message: Uint8Array) => Promise<Uint8Array>,
  signal: AbortSignal
) {
  const challenge: SocialChallenge = await socialRequest(
    path,
    { action: 'challenge', wallet },
    undefined,
    signal
  );
  assertSocialChallenge(challenge, window.location.origin, wallet, purpose, null);
  const signature = messageSignature(
    await signMessage(new TextEncoder().encode(challenge.message))
  );
  signal.throwIfAborted();
  await socialRequest(
    path,
    { action: 'join', wallet, nonce: challenge.nonce, signature },
    undefined,
    signal
  );
}
