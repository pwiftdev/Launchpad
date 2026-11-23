import { DropdownMenu } from 'radix-ui';
import { toast } from 'sonner';
import { BRAND } from '@/constants/brand';
import { cn } from '@/lib/utils';

type ShareButtonProps = {
  mint: string;
  symbol: string;
  className?: string;
};

/** Copy the coin link or open a pre-filled post on X. The link unfurls into the coin's share card. */
export const ShareButton = ({ mint, symbol, className }: ShareButtonProps) => {
  const url = () => `${window.location.origin}/token/${mint}`;
  const text = `$${symbol} on ${BRAND.xHandle}.\n\nExplore the token and its launch details. 🧼`;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        aria-label="Share"
        title="Share"
        className={cn(
          'inline-flex h-9 w-9 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-900 hover:text-neutral-100 data-[state=open]:bg-neutral-900 data-[state=open]:text-neutral-100',
          className
        )}
      >
        <span className="iconify h-4 w-4 ph--share-network" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-[60] min-w-44 rounded-lg border border-neutral-800 bg-neutral-950 p-1 text-sm shadow-xl data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        >
          <DropdownMenu.Item
            onSelect={() => {
              navigator.clipboard
                .writeText(url())
                .then(() => toast.success('Link copied. It unfurls into a share card on X.'))
                .catch(() => toast.error('Could not copy the link'));
            }}
            className="flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-neutral-200 outline-none data-[highlighted]:bg-neutral-900"
          >
            <span className="iconify h-4 w-4 ph--link" />
            Copy link
          </DropdownMenu.Item>
          <DropdownMenu.Item
            onSelect={() => {
              const intent = `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url())}`;
              window.open(intent, '_blank', 'noopener,noreferrer');
            }}
            className="flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-neutral-200 outline-none data-[highlighted]:bg-neutral-900"
          >
            <span className="iconify h-4 w-4 ph--x-logo" />
            Post on X
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
};
