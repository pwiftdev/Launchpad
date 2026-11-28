import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Coin, Trade } from '@/lib/coin';
import { RecentTrades } from './RecentTrades';

vi.mock('@/hooks/useCoins', () => ({
  useRecentTrades: () => ({
    data: {
      trades: [{ sig: 'receipt', side: 'buy', sol: 1.25, ts: 100 } as Trade],
      complete: true,
    },
  }),
}));

beforeEach(() => vi.stubGlobal('React', React));
afterEach(() => vi.unstubAllGlobals());

it('shows the recorded SOL amount and its USD estimate together', () => {
  const coin = { isDemo: false } as Coin;
  const html = renderToStaticMarkup(createElement(RecentTrades, { coin, solUsd: 100 }));
  expect(html).toContain('1.25 SOL');
  expect(html).toContain('≈ $125.00');
  const withoutRate = renderToStaticMarkup(createElement(RecentTrades, { coin }));
  expect(withoutRate).toContain('1.25 SOL');
  expect(withoutRate).not.toContain('$0');
});
