import { describe, expect, it } from 'vitest';
import type { Trade } from './coin';
import { computePot } from './pot';

const LAUNCH = 1_000_000;
const trade = (over: Partial<Trade>): Trade => ({
  sig: Math.random().toString(36),
  ts: LAUNCH,
  side: 'buy',
  wallet: 'w',
  sol: 1,
  tokens: 1,
  feeSol: 0.0125,
  priceSol: 0,
  marketCapSol: 0,
  ...over,
});

describe('computePot', () => {
  it('sends 80% of the fee above 1.25% to the pot for tax-window trades', () => {
    // Sniper buys 1 SOL at t=0 and pays the 90% cliff
    const pot = computePot([trade({ feeSol: 0.9 })], LAUNCH);
    expect(pot.excessSol).toBeCloseTo(0.8875, 9);
    expect(pot.potSol).toBeCloseTo(0.71, 9);
    expect(pot.taxedTrades).toBe(1);
  });

  it('adds nothing for trades at the 1.25% floor, like the dev first buy', () => {
    const pot = computePot([trade({ feeSol: 0.0125 })], LAUNCH);
    expect(pot.potSol).toBe(0);
    expect(pot.taxedTrades).toBe(0);
  });

  it('treats the real on-chain floor of 1.2505% as untaxed', () => {
    const pot = computePot([trade({ sol: 0.1, feeSol: 0.0012505 })], LAUNCH);
    expect(pot.taxedTrades).toBe(0);
    expect(pot.potSol).toBe(0);
  });

  it('values sells by SOL received plus the fee', () => {
    // Sell worth 1 SOL before fee: receives 0.44, pays 0.56 at t=3s
    const pot = computePot(
      [trade({ side: 'sell', sol: 0.44, feeSol: 0.56, ts: LAUNCH + 3 })],
      LAUNCH
    );
    expect(pot.excessSol).toBeCloseTo(0.56 - 0.0125, 9);
  });

  it('ignores fees above the base after the 27s window (dynamic fee)', () => {
    const pot = computePot([trade({ feeSol: 0.02, ts: LAUNCH + 60 })], LAUNCH);
    expect(pot.potSol).toBe(0);
    expect(pot.feesSol).toBeCloseTo(0.02, 9);
  });
});
