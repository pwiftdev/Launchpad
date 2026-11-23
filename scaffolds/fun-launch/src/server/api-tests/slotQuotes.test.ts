import BN from 'bn.js';
import { Keypair, PublicKey } from '@solana/web3.js';
import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  coin: vi.fn(),
  clock: vi.fn(),
  slot: vi.fn(),
  quote: vi.fn(),
  swap: vi.fn(),
  block: vi.fn(),
}));
vi.mock('@/server/apiGuard', () => ({ apiGuard: () => true }));
vi.mock('@/server/tradingAccess', () => ({ allowTrading: async () => true }));
vi.mock('@/server/dbc', async () => {
  const { PublicKey } = await import('@solana/web3.js');
  return {
    getCoin: mocks.coin,
    chainTime: mocks.clock,
    connection: { getSlot: mocks.slot, getLatestBlockhashAndContext: mocks.block },
    dbc: { pool: { swapQuote: mocks.quote, swap: mocks.swap } },
    parseKey: (value: string) => new PublicKey(value),
    networkGenesis: async () => '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  };
});
import quoteHandler from '@/pages/api/quote';
import swapHandler from '@/pages/api/swap-tx';
const mint = Keypair.generate().publicKey.toBase58();
let activationType: number;
const response = () => {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
};
beforeEach(() => {
  vi.clearAllMocks();
  activationType = 0;
  mocks.clock.mockRejectedValue(new Error('Timestamp unavailable in the launch slot'));
  mocks.slot.mockResolvedValue(101);
  mocks.coin.mockImplementation(async () => ({
    coin: { isMigrated: false, tokenDecimals: 6, pool: mint, priceSol: 1 },
    account: { poolState: { activationPoint: new BN(100) } },
    config: {
      activationType,
      tokenDecimal: 6,
      collectFeeMode: 0,
      poolFees: {
        baseFee: {
          baseFeeMode: 0,
          cliffFeeNumerator: new BN(990000000),
          firstFactor: 1,
          secondFactor: new BN(1),
          thirdFactor: new BN(977500000),
        },
      },
    },
  }));
  mocks.quote.mockReturnValue({
    tradingFee: new BN(10000000),
    protocolFee: new BN(2500000),
    referralFee: new BN(0),
    outputAmount: new BN(1000000),
    minimumAmountOut: new BN(990000),
  });
  mocks.swap.mockResolvedValue({ serialize: () => Buffer.from('unsigned-fixture') });
  mocks.block.mockResolvedValue({
    context: { slot: 101 },
    value: { blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 500 },
  });
});
it.each([
  [100, 99],
  [101, 1.25],
])('quotes the fee at slot %i even when block time is unavailable', async (slot, fee) => {
  mocks.slot.mockResolvedValue(slot);
  const res = response();
  await quoteHandler(
    { method: 'GET', query: { mint, side: 'buy', amount: '1' } } as unknown as NextApiRequest,
    res as unknown as NextApiResponse
  );
  expect(res.status).toHaveBeenCalledWith(200);
  expect(res.json.mock.calls[0]?.[0].taxPercent).toBe(fee);
  expect(mocks.clock).not.toHaveBeenCalled();
  expect(mocks.quote.mock.calls[0]?.[0].currentPoint.toNumber()).toBe(slot);
});
it('prepares a slot-based trade without depending on a timestamp lookup', async () => {
  const res = response();
  await swapHandler(
    {
      method: 'POST',
      body: { mint, side: 'buy', amount: 1, wallet: mint, slippageBps: 100 },
    } as unknown as NextApiRequest,
    res as unknown as NextApiResponse
  );
  expect(res.status).toHaveBeenCalledWith(200);
  expect(mocks.clock).not.toHaveBeenCalled();
  expect(mocks.quote.mock.calls[0]?.[0].currentPoint.toNumber()).toBe(101);
  expect(mocks.quote.mock.calls[0]?.[0].eligibleForFirstSwapWithMinFee).toBe(false);
});
it('keeps timestamp activation for historical configurations', async () => {
  activationType = 1;
  mocks.clock.mockResolvedValue(101);
  const res = response();
  await quoteHandler(
    { method: 'GET', query: { mint, side: 'buy', amount: '1' } } as unknown as NextApiRequest,
    res as unknown as NextApiResponse
  );
  expect(res.status).toHaveBeenCalledWith(200);
  expect(mocks.clock).toHaveBeenCalledOnce();
  expect(mocks.slot).not.toHaveBeenCalled();
});
