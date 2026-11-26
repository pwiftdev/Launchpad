import { useEffect, useState } from 'react';
import { BRAND } from '@/constants/brand';
import {
  Dialog,
  DialogCloseButton,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/Dialog';

const DISMISSED_KEY = 'mskd.community-invite.dismissed';

export function CommunityInvite() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    try {
      setOpen(sessionStorage.getItem(DISMISSED_KEY) !== '1');
    } catch {
      setOpen(true);
    }
  }, []);

  function dismiss() {
    setOpen(false);
    try {
      sessionStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      return;
    }
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && dismiss()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-[560px] gap-0 overflow-y-auto overscroll-contain rounded-xl border-white/15 bg-[#160b06] shadow-2xl outline-none motion-reduce:animate-none">
        <DialogCloseButton
          aria-label="Close community invite"
          className="absolute right-3 top-3 z-10 size-11 bg-black/65 text-white hover:bg-black focus-visible:outline-2 focus-visible:outline-white"
        />
        <div
          aria-hidden="true"
          className="aspect-[1280/853] bg-cover bg-center"
          style={{ backgroundImage: `url("${BRAND.assets.communityInvite}")` }}
        />
        <div className="flex flex-col items-center px-5 py-6 text-center sm:px-8 sm:py-7">
          <DialogTitle className="font-display text-xl font-normal leading-snug text-white sm:text-2xl">
            Join the {BRAND.longName} community
          </DialogTitle>
          <DialogDescription className="mt-2 text-base text-neutral-200">
            Get launch updates and chat with builders and traders.
          </DialogDescription>
          <a
            className="btn-holo mt-5 inline-flex min-h-11 w-full items-center justify-center gap-2 px-5 py-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white sm:w-auto"
            href={BRAND.telegramInvite}
            target="_blank"
            rel="noopener noreferrer"
            onClick={dismiss}
          >
            <span className="iconify size-4 ph--paper-plane-tilt-fill" aria-hidden="true" />
            Join on Telegram
          </a>
        </div>
      </DialogContent>
    </Dialog>
  );
}
