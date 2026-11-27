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
        <Dialog.Overlay className="fixed inset-0 z-40 bg-[rgb(10_8_7/0.62)] duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content
          onInteractOutside={(event) => {
            if (showModal) event.preventDefault();
          }}
          aria-describedby={undefined}
          className="glass-strong fixed inset-y-0 right-0 z-50 flex w-full max-w-[1160px] flex-col overflow-y-auto overscroll-contain bg-[rgb(22_19_17/0.97)] outline-none duration-300 ease-out will-change-transform [-webkit-backdrop-filter:none] [backdrop-filter:none] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:duration-150 data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right-1/3 data-[state=open]:fade-in-0 md:inset-y-3 md:right-3 md:w-[calc(100%-1.5rem)] md:rounded-[30px]"
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
                    className="hidden h-9 w-9 place-items-center rounded-full text-neutral-400 ring-1 ring-inset ring-white/10 transition-all duration-200 ease-out hover:bg-white/10 hover:text-neutral-50 sm:grid"
                    aria-label="Open full page"
                    title="Open full page"
                  >
                    <span className="iconify block h-4 w-4 ph--arrows-out-simple" />
                  </Link>
                  <Dialog.Close
                    className="grid h-9 w-9 place-items-center rounded-full text-neutral-400 ring-1 ring-inset ring-white/10 transition-all duration-200 ease-out hover:rotate-90 hover:bg-white/10 hover:text-neutral-50"
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
              <Dialog.Close className="btn-glass h-10 px-4 text-sm">Back to the board</Dialog.Close>
            </div>
          ) : (
            <div className="space-y-3 p-4 sm:p-5" aria-busy>
              <div className="flex items-center gap-3">
                <div className="skeleton h-14 w-14 rounded-2xl" />
                <div className="flex-1 space-y-2">
                  <div className="skeleton h-4 w-1/3" />
                  <div className="skeleton h-3 w-1/4" />
                </div>
              </div>
              <div className="grid gap-3 lg:grid-cols-[1fr_340px]">
                <div className="skeleton h-[380px] rounded-3xl" />
                <div className="skeleton h-[380px] rounded-3xl" />
              </div>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
