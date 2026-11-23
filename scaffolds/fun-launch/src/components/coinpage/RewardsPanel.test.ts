import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { Coin } from '@/lib/coin';
import type { RewardsView } from '@/lib/rewards';
const mocks = vi.hoisted(() => ({ data: null as RewardsView | null }));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: mocks.data, isLoading: false, isError: false, isFetching: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock('@jup-ag/wallet-adapter', () => ({
  useUnifiedWalletContext: () => ({ setShowModal: vi.fn() }),
  useWallet: () => ({
    publicKey: { toBase58: () => 'wallet' },
    signMessage: vi.fn(),
    get signTransaction() {
      throw Error('Holder transactions must never be requested');
    },
  }),
}));
import { RewardsPanel } from './RewardsPanel';
const coin: Coin = {
  mint: 'mint',
  pool: 'pool',
  creator: 'creator',
  mode: 'creator',
  feePolicyVersion: 'wallet-v1',
  name: 'Coin',
  symbol: 'COIN',
  image: null,
  launchedAt: 1,
  quoteReserveSol: 1,
  thresholdSol: 80,
  progress: 0,
  isMigrated: false,
  priceSol: 1,
  marketCapSol: 1,
};
beforeEach(() => {
  vi.stubGlobal('React', React);
  mocks.data = {
    networkGenesis: 'network',
    payoutMethod: 'server-paid',
    status: 'ready',
    mode: 'creator',
    availableLamports: '1000000',
    paidLamports: '0',
    epochs: [],
  };
});
afterEach(() => vi.unstubAllGlobals());
it('offers a message-only server-paid payout with no holder signing or rent requirement', () => {
  const html = renderToStaticMarkup(React.createElement(RewardsPanel, { coin }));
  expect(html).toContain('Request SOL payout');
  expect(html).toContain('MSKD.fun pays the network fee');
  expect(html).toContain('No token approval, transaction signature, or claim account is needed');
  expect(html).not.toContain('NEXT_PUBLIC_VAULT');
  expect(html).not.toContain('verified on-chain');
});
it('keeps a queued payout pending and offers a check instead of another payout request', () => {
  mocks.data!.creatorJob = { id: 'job', status: 'queued', signature: null };
  const html = renderToStaticMarkup(React.createElement(RewardsPanel, { coin }));
  expect(html).toContain('Check saved request');
  expect(html).not.toContain('Request SOL payout');
  expect(html).not.toContain('reward is confirmed');
});
it('does not offer wallet payouts for a token with a legacy custody policy', () => {
  const html = renderToStaticMarkup(
    React.createElement(RewardsPanel, { coin: { ...coin, feePolicyVersion: 'rinse-v1' } })
  );
  expect(html).toContain('original launch policy');
  expect(html).not.toContain('Request SOL payout');
});
it('allows the original creator to request funded Bond it. rewards after bonding', () => {
  mocks.data!.mode = 'bond';
  mocks.data!.creatorReceipts = [
    { signature: 'confirmed-receipt', lamports: '500000', finalizedSlot: '100' },
  ];
  const html = renderToStaticMarkup(
    React.createElement(RewardsPanel, {
      coin: { ...coin, mode: 'bond', feePolicyVersion: 'bond-v1', isMigrated: true },
    })
  );
  expect(html).toContain('Creator rewards');
  expect(html).toContain('Request SOL payout');
  expect(html).toContain('confirmed-receipt');
  expect(html).not.toContain('Community rewards');
  expect(html).not.toContain('original launch policy');
});
it('explains the pre-bond buyback allocation without offering an unfunded creator payout', () => {
  mocks.data!.mode = 'bond';
  mocks.data!.availableLamports = '0';
  const html = renderToStaticMarkup(
    React.createElement(RewardsPanel, {
      coin: { ...coin, mode: 'bond', feePolicyVersion: 'bond-v1' },
    })
  );
  expect(html).toContain('Creator rewards start after bonding');
  expect(html).not.toContain('Request SOL payout');
});
