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
export function mergeCallouts(current: Callout[], incoming: Callout[]): Callout[] {
  return [...new Map([...current, ...incoming].map((row) => [row.id, row])).values()]
    .sort((a, b) => (BigInt(a.id) > BigInt(b.id) ? -1 : BigInt(a.id) < BigInt(b.id) ? 1 : 0))
    .slice(0, 200);
}

export function socialMessage(
  origin: string,
  wallet: string,
  purpose: string,
  payload: unknown,
  nonce: string,
  expiresAt: string
) {
  return [
    'plzzz.bond · Wallet profile and callouts',
    `Site: ${origin}`,
    `Wallet: ${wallet}`,
    `Action: ${purpose}`,
    `Content: ${JSON.stringify(payload)}`,
    `Nonce: ${nonce}`,
    `Expires: ${expiresAt}`,
    'This message only updates your public profile or posts a callout. It cannot move funds.',
  ].join('\n');
}

/** Never hand arbitrary server text to a wallet's signMessage method. */
export function assertSocialChallenge(
  challenge: SocialChallenge,
  origin: string,
  wallet: string,
  purpose: 'profile' | 'callout',
  draft: ProfileDraft | { mint: string; body: string },
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
  if (purpose === 'profile' && 'username' in draft) {
    payload = {
      username: draft.username.trim().toLowerCase(),
      bio: draft.bio.trim(),
      avatarUrl: draft.avatarUrl,
    };
  } else if (purpose === 'callout' && 'mint' in draft) {
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
    payload = { networkGenesis: parsed.networkGenesis, mint: draft.mint, body: draft.body.trim() };
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

export async function socialRequest(path: '/api/profiles' | '/api/callouts', body: object) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Unable to save. Please try again.');
  return result;
}

export function messageSignature(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
}
