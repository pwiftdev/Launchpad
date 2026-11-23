import { useEffect, useId, useRef } from 'react';
import { LogoMark, Wordmark } from './Logo';

/** Brand the shared picker while keeping the adapter's wallet discovery and connection flow. */
export const WalletModalBranding = () => {
  const footer = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = footer.current?.closest('dialog');
    const header = footer.current?.parentElement?.firstElementChild;
    const title = header?.querySelector('span');
    const close = header?.querySelector('button');
    if (!dialog || !title) return;
    title.id = titleId;
    dialog.setAttribute('aria-labelledby', titleId);
    close?.setAttribute('aria-label', 'Close wallet connection');
  }, [titleId]);

  return (
    <div ref={footer} data-plzzz-wallet="true" className="plzzz-wallet-footer">
      <div className="plzzz-wallet-brand" aria-hidden="true">
        <LogoMark small className="h-9 w-8 sm:h-11 sm:w-9" />
        <Wordmark className="text-[16px] sm:text-[19px]" />
      </div>
      <span className="iconify h-4 w-4 shrink-0 text-primary ph--shield-check" aria-hidden="true" />
      <p>
        Your keys stay in your wallet. No KYC, no account.
        <span className="block text-neutral-400">We never ask for your recovery phrase.</span>
      </p>
    </div>
  );
};
