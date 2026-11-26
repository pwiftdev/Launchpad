import {
  assertSocialChallenge,
  messageSignature,
  socialRequest,
  type SocialChallenge,
} from './profiles';
import type { FeeModeId } from './feeModes';
import type { Socials } from './socials';

export type LaunchPreviewDraft = {
  tokenLogo: string;
  tokenName: string;
  tokenSymbol: string;
  devBuyPercent: number;
  sourceUrl?: string;
  description?: string;
  socials?: Socials;
  mode: FeeModeId;
};

export type PreviewInvite = {
  id: string;
  viewerWallet: string | null;
  expiresAt: string;
};

export type SavedPreview = {
  revision: number;
  draft: LaunchPreviewDraft | null;
  invites: PreviewInvite[];
};
export type SharedPreview = { draft: LaunchPreviewDraft; expiresAt: string; expiresInMs: number };
export const PREVIEW_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const PREVIEW_API = '/api/launch-previews';
export const PREVIEW_WALLET_HEADER = 'X-Preview-Wallet';
const PREVIEW_TAB_LINK = /^view-[a-f0-9-]{36}$/;
const PREVIEW_TAB_KEY = 'mskd.launch-preview.';

export function readPreviewInvite(): string {
  const { hash, pathname, search } = window.location;
  const fragment = hash.slice(1);
  if (PREVIEW_TAB_LINK.test(fragment)) {
    try {
      return sessionStorage.getItem(PREVIEW_TAB_KEY + fragment) ?? '';
    } catch {
      return '';
    }
  }
  if (!PREVIEW_TOKEN_PATTERN.test(fragment)) return '';
  let marker = '';
  try {
    const entry = `view-${crypto.randomUUID()}`;
    sessionStorage.setItem(PREVIEW_TAB_KEY + entry, fragment);
    marker = `#${entry}`;
  } catch {
    // The current view can still open if tab storage is unavailable.
  }
  // Wallet adapters can include the current URL in their mobile handoff.
  window.history.replaceState(window.history.state, '', pathname + search + marker);
  return fragment;
}

export function previewRequest<T>(body: object, wallet?: string, signal?: AbortSignal): Promise<T> {
  return socialRequest(
    PREVIEW_API,
    body,
    wallet ? { [PREVIEW_WALLET_HEADER]: wallet } : undefined,
    signal
  );
}

export async function unlockPreview(
  wallet: string,
  signMessage: (message: Uint8Array) => Promise<Uint8Array>,
  signal: AbortSignal
) {
  const challenge = await previewRequest<SocialChallenge>(
    { action: 'challenge', wallet },
    undefined,
    signal
  );
  assertSocialChallenge(challenge, window.location.origin, wallet, 'launch-preview', null);
  const signature = messageSignature(
    await signMessage(new TextEncoder().encode(challenge.message))
  );
  signal.throwIfAborted();
  await previewRequest(
    { action: 'join', wallet, nonce: challenge.nonce, signature },
    undefined,
    signal
  );
}

export function readLaunchImage(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Could not read the image'));
    reader.readAsDataURL(file);
  });
}

export function restorePreviewImage(dataUrl: string): File {
  const prefix = 'data:image/webp;base64,';
  if (!dataUrl.startsWith(prefix)) throw new Error('The saved image could not be read.');
  const bytes = Uint8Array.from(atob(dataUrl.slice(prefix.length)), (byte) => byte.charCodeAt(0));
  return new File([bytes], 'preview.webp', { type: 'image/webp' });
}
