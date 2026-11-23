import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PriceChart } from './PriceChart';
import type { Coin, TradesResponse } from '@/lib/coin';

vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'dark' }) }));
vi.mock('@/hooks/useUsd', () => ({ useSolPrice: () => ({ data: 150, isError: false }) }));
beforeEach(() => vi.stubGlobal('React', React));
afterEach(() => vi.unstubAllGlobals());
const coin = { mint: 'real-mint', symbol: 'REAL', tokenSupply: 1_000_000, launchedAt: 100 } as Coin;
const history = { trades: [], complete: true, launchPriceSol: 0.1 } as unknown as TradesResponse;
const render = (props: Partial<Parameters<typeof PriceChart>[0]> = {}) =>
  renderToStaticMarkup(createElement(PriceChart, { coin, trades: history, ...props }));

describe('market chart states', () => {
  it('shows honest loading, empty and failure states instead of a generated launch candle', () => {
    expect(render({ trades: undefined, isLoading: true })).toContain('Loading recorded trades');
    const empty = render();
    expect(empty).toContain('No recorded trades yet');
    expect(empty).toContain('0 recorded intervals');
    expect(empty).not.toContain('Sample');
    expect(
      render({ trades: undefined, error: new Error('provider secret'), onRetry: () => {} })
    ).toContain('Retry market history');
    expect(render({ trades: undefined, error: new Error('provider secret') })).not.toContain(
      'provider secret'
    );
  });
  it('retains cached data and warns when refresh fails or indexing is pending', () => {
    const html = render({
      trades: { ...history, stale: true, pendingCount: 2 },
      error: new Error('offline'),
    });
    expect(html).toContain('Updates delayed. Showing the last available trades.');
    expect(html).toContain('Waiting for 2 recent transaction');
  });
  it('does not assume a token supply when a real mint has not been verified', () => {
    expect(render({ coin: { ...coin, tokenSupply: undefined } })).toContain(
      'Verified token supply is unavailable. Select token price'
    );
    expect(render()).toContain('current verified supply');
  });
  it('exposes subminute controls, keyboard zoom controls and an explicitly marked demo only for fixtures', () => {
    const html = render({ coin: { ...coin, isDemo: true } });
    for (const label of [
      '1s',
      '5s',
      '15s',
      '1m',
      'Zoom in chart',
      'Zoom out chart',
      'Chart currency',
      'Chart style',
      'Sample',
    ])
      expect(html).toContain(label);
  });
});
