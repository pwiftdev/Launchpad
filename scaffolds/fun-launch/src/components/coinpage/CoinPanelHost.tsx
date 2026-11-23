import { useEffect } from 'react';
import Link from 'next/link';
import { Dialog } from 'radix-ui';
import { useUnifiedWalletContext } from '@jup-ag/wallet-adapter';
import { useCoin } from '@/hooks/useCoins';
import { resetPanelHistory, useCoinPanel } from '@/hooks/useCoinPanel';
import { CoinPanel } from './CoinPanel';

/**
 * Slides the coin panel in over the current page when the URL has `?coin=<mint>`.
 * Mounted once by the page shell, so any coin link anywhere opens it without a page load.
 */
export const CoinPanelHost = () => {
  const { openMint, close } = useCoinPanel();
  const { showModal } = useUnifiedWalletContext();
  const { data: coin, status, error } = useCoin(openMint);

  useEffect(() => {
    if (!openMint) resetPanelHistory();
  }, [openMint]);

  return (
    <Dialog.Root
      modal={!showModal}
      open={!!openMint}
      onOpenChange={(open) => !open && !showModal && close()}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content
          onInteractOutside={(event) => {
            if (showModal) event.preventDefault();
          }}
          aria-describedby={undefined}
          className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[1120px] flex-col overflow-y-auto border-l border-white/[0.08] bg-panel shadow-2xl outline-none duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right"
        >
          <Dialog.Title className="sr-only">
            {coin ? `${coin.name} ($${coin.symbol})` : 'Coin'}
          </Dialog.Title>
          {coin ? (
            <CoinPanel
              coin={coin}
              headerActions={
                <div className="flex items-center gap-1">
                  <Link
                    href={`/token/${coin.mint}`}
                    className="hidden rounded-lg p-2 text-neutral-500 hover:bg-neutral-900 hover:text-neutral-100 sm:block"
                    aria-label="Open full page"
                    title="Open full page"
                  >
                    <span className="iconify block h-4 w-4 ph--arrows-out-simple" />
                  </Link>
                  <Dialog.Close
                    className="rounded-lg p-2 text-neutral-500 hover:bg-neutral-900 hover:text-neutral-100"
                    aria-label="Close"
                  >
                    <span className="iconify block h-5 w-5 ph--x" />
                  </Dialog.Close>
                </div>
              }
            />
          ) : status === 'error' ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
              <p className="text-sm text-neutral-400">
                {error instanceof Error ? error.message : 'Coin not found'}
              </p>
              <Dialog.Close className="text-sm text-primary hover:underline">
                Back to the board
              </Dialog.Close>
            </div>
          ) : (
            <div className="space-y-4 p-5" aria-busy>
              <div className="h-10 w-1/2 animate-pulse rounded-lg bg-neutral-900" />
              <div className="h-[360px] animate-pulse rounded-lg bg-neutral-900" />
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
