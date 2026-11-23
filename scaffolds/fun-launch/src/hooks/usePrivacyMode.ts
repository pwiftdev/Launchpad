import { useEffect } from 'react';
import { useAtom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';

/**
 * Privacy mode ("screen mode"): blurs wallet addresses and identities anywhere they render
 * with `data-private`, so the app can be streamed or screenshotted without doxxing anyone.
 * Browser-local only; nothing is sent anywhere.
 */
const privacyAtom = atomWithStorage('mskd.privacy', false);

export function usePrivacyMode() {
  const [enabled, setEnabled] = useAtom(privacyAtom);
  return { enabled, setEnabled, toggle: () => setEnabled((v) => !v) };
}

/** Mount once: mirrors the setting onto <html> and binds Shift+P outside text fields. */
export function usePrivacyModeSync() {
  const { enabled, setEnabled } = usePrivacyMode();
  useEffect(() => {
    document.documentElement.classList.toggle('privacy-on', enabled);
  }, [enabled]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing =
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable;
      if (!typing && e.shiftKey && !e.metaKey && !e.ctrlKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        setEnabled((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setEnabled]);
}
