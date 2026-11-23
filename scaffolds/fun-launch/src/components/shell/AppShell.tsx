import { useEffect, useState } from 'react';
import { Tooltip } from 'radix-ui';
import { cn } from '@/lib/utils';
import { CoinPanelHost } from '../coinpage/CoinPanelHost';
import { SideRail } from './SideRail';
import { TopBar } from './TopBar';
import { TickerStrip } from './TickerStrip';
import { StatusBar } from './StatusBar';
import { MobileTabBar } from './MobileTabBar';
import { CommandPalette } from './CommandPalette';
import { PaletteContext } from './paletteContext';
import { usePrivacyModeSync } from '@/hooks/usePrivacyMode';

const LIT = '.surface, .glass, .board-surface, .holo-border';

type AppShellProps = React.PropsWithChildren<{
  /** Board-style page: main area fills the viewport and does not scroll as a whole */
  fill?: boolean;
  mainClassName?: string;
}>;

/** MSKD.fun app frame: side rail, top bar, ticker strip, status bar, coin panel and command palette. */
export const AppShell = ({ fill, mainClassName, children }: AppShellProps) => {
  const [paletteOpen, setPaletteOpen] = useState(false);
  usePrivacyModeSync();

  // A soft light follows the cursor across glass panels (and lights their top edge)
  useEffect(() => {
    let lit: HTMLElement | null = null;
    const onMove = (e: PointerEvent) => {
      const el = (e.target as Element | null)?.closest?.(LIT) as HTMLElement | null;
      if (lit && lit !== el) {
        lit.style.removeProperty('--mx');
        lit.style.removeProperty('--my');
      }
      lit = el;
      if (!el) return;
      const r = el.getBoundingClientRect();
      el.style.setProperty('--mx', `${e.clientX - r.left}px`);
      el.style.setProperty('--my', `${e.clientY - r.top}px`);
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, []);

  // Ctrl/Cmd+K anywhere, or "/" outside text fields, opens the palette
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing =
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable;
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <PaletteContext.Provider value={{ open: paletteOpen, setOpen: setPaletteOpen }}>
      <Tooltip.Provider>
        {/* Fixed frame: the bars never move, only <main> scrolls */}
        <div className="flex h-dvh overflow-hidden text-foreground">
          <SideRail />
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <TopBar />
            <TickerStrip />
            <main
              className={cn(
                'flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain pb-28 md:pb-0',
                fill && 'p-2 pb-28 md:overflow-hidden md:p-3',
                mainClassName
              )}
            >
              {children}
            </main>
            <StatusBar />
          </div>
        </div>
        <MobileTabBar />
        <CoinPanelHost />
        <CommandPalette />
      </Tooltip.Provider>
    </PaletteContext.Provider>
  );
};
