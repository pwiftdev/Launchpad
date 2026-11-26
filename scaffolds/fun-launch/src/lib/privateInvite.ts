export const PRIVATE_INVITE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const PREVIEW_TAB_LINK = /^view-[a-f0-9-]{36}$/;

export function readPrivateInvite(storagePrefix: string): string {
  const { hash, pathname, search } = window.location;
  const fragment = hash.slice(1);
  if (PREVIEW_TAB_LINK.test(fragment)) {
    try {
      return sessionStorage.getItem(storagePrefix + fragment) ?? '';
    } catch {
      return '';
    }
  }
  if (!PRIVATE_INVITE_TOKEN.test(fragment)) return '';
  let marker = '';
  try {
    const entry = `view-${crypto.randomUUID()}`;
    sessionStorage.setItem(storagePrefix + entry, fragment);
    marker = `#${entry}`;
  } catch {
    // The current view can still open if tab storage is unavailable.
  }
  // Wallet adapters can include the current URL in their mobile handoff.
  window.history.replaceState(window.history.state, '', pathname + search + marker);
  return fragment;
}
