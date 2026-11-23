import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
beforeEach(() => vi.stubGlobal('React', React));
afterEach(() => vi.unstubAllGlobals());
vi.mock('@/hooks/useCoins', () => ({ useCoin: () => ({ data: null as null }) }));
vi.mock('@/hooks/useUsd', () => ({ useUsd: () => ({ usd: () => '$0' }) }));
vi.mock('@/hooks/useWatchlist', () => ({
  useWatchlist: () => ({ add: vi.fn(), toggle: vi.fn(), isWatched: () => false }),
}));
vi.mock('@/components/coin/CoinAvatar', () => ({ CoinAvatar: (): null => null }));
vi.mock('@/components/coin/BondingBar', () => ({ BondingBar: (): null => null }));
import { LaunchSuccess, type LaunchReceipt } from './LaunchSuccess';
const receipt: LaunchReceipt = {
  mint: '11111111111111111111111111111111',
  signature: 'public-transaction-id',
  name: 'Test',
  symbol: 'TEST',
  image: null,
  devBuyPercent: 0,
  registryStatus: 'pending',
};
it('never presents an uncertain relay/finality receipt as successful or shareable', () => {
  const html = renderToStaticMarkup(
    React.createElement(LaunchSuccess, { receipt, onReset: () => {} })
  );
  expect(html).toContain('data-launch-success="pending"');
  expect(html).toContain('Confirmation pending');
  expect(html).toContain('checking submission');
  expect(html).toContain('is being checked.');
  expect(html).not.toContain('Confirmed on Solana');
  expect(html).not.toContain('Your launch transaction succeeded');
  expect(html).not.toContain('>is live.<');
  expect(html).not.toContain('intent/tweet');
  expect(html).toMatch(/disabled=""[^>]*>[^<]*<span[^>]*><\/span> Launch another coin/);
});
it('shows chain success/share only after registry verification', () => {
  const html = renderToStaticMarkup(
    React.createElement(LaunchSuccess, {
      receipt: { ...receipt, registryStatus: 'registered' },
      onReset: () => {},
    })
  );
  expect(html).toContain('data-launch-success="true"');
  expect(html).toContain('Confirmed on Solana');
  expect(html).toContain('Your launch transaction succeeded');
  expect(html).toContain('intent/tweet');
});
it('remounts all confirmation and expiry state when the same mint receives a different receipt identity', () => {
  const original = LaunchSuccess({ receipt, onReset: () => {} });
  for (const change of [
    { signature: 'other-signature' },
    { genesis: 'other-genesis' },
    { wallet: 'other-wallet' },
    { mode: 'community' as const },
  ]) {
    const next = LaunchSuccess({ receipt: { ...receipt, ...change }, onReset: () => {} });
    expect(next.key).not.toBe(original.key);
  }
  expect(
    LaunchSuccess({ receipt: { ...receipt, name: 'New display name' }, onReset: () => {} }).key
  ).toBe(original.key);
});
