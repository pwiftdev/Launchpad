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
  const text = `$${symbol} on ${BRAND.xHandle}.\n\nExplore the token and its launch details.`;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        aria-label="Share"
        title="Share"
        className={cn(
          'inline-flex h-9 w-9 items-center justify-center rounded-full text-neutral-400 transition-all duration-200 ease-out hover:bg-white/[0.08] hover:text-neutral-100 data-[state=open]:bg-white/[0.05] data-[state=open]:text-neutral-100',
          className
        )}
      >
        <span className="iconify h-4 w-4 ph--share-network" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="glass-strong z-[60] min-w-48 rounded-2xl p-1.5 text-sm duration-200 ease-out data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:slide-in-from-top-1"
        >
          <DropdownMenu.Item
            onSelect={() => {
              navigator.clipboard
                .writeText(url())
                .then(() => toast.success('Link copied. It unfurls into a share card on X.'))
                .catch(() => toast.error('Could not copy the link'));
            }}
            className="flex cursor-pointer items-center gap-2.5 rounded-xl px-3 py-2.5 text-neutral-200 outline-none transition-colors duration-200 data-[highlighted]:bg-white/[0.08] data-[highlighted]:text-foreground"
          >
            <span className="iconify h-4 w-4 ph--link" />
            Copy link
          </DropdownMenu.Item>
          <DropdownMenu.Item
            onSelect={() => {
              const intent = `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url())}`;
              window.open(intent, '_blank', 'noopener,noreferrer');
            }}
            className="flex cursor-pointer items-center gap-2.5 rounded-xl px-3 py-2.5 text-neutral-200 outline-none transition-colors duration-200 data-[highlighted]:bg-white/[0.08] data-[highlighted]:text-foreground"
          >
            <span className="iconify h-4 w-4 ph--x-logo" />
            Post on X
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
};
