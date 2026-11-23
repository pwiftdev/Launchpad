import { describe, expect, it } from 'vitest';
import {
  BENEFICIARY_NET_BPS,
  FEE_MODE_IDS,
  SCHEDULE,
  SPLIT,
  feeMode,
  feeModeByPolicy,
  isFeeModeId,
  pct,
  quoteMintFor,
  splitRows,
} from './feeModes';

describe('fee modes', () => {
  it('charges a flat 1.25% before and after bonding, after a one-slot 99% guard', () => {
    expect(SCHEDULE.startingFeeBps).toBe(9900);
    expect(SCHEDULE.periodSlots).toBe(1);
    expect(SCHEDULE.endingFeeBps).toBe(125);
    expect(SCHEDULE.migrationFeeBps).toBe(125);
    expect(SCHEDULE.startingFeeBps - SCHEDULE.reductionBps).toBe(SCHEDULE.endingFeeBps);
  });

  it('splits every 1.25% as Meteora 0.25, house 0.40, mode 0.60', () => {
    expect(SPLIT).toEqual({ meteoraBps: 25, houseBps: 40, beneficiaryBps: 60 });
    expect(SPLIT.meteoraBps + SPLIT.houseBps + SPLIT.beneficiaryBps).toBe(SCHEDULE.endingFeeBps);
    // Meteora keeps 20% of the trading fee on both DBC and DAMM v2
    expect(SPLIT.meteoraBps / SCHEDULE.endingFeeBps).toBe(0.2);
    // Of the income we collect, 60% routes to the beneficiary and 40% stays with the house
    expect(BENEFICIARY_NET_BPS).toBe(6000);
  });

  it('defines MSKD, Regular Dev and Regular Cashback', () => {
    expect(FEE_MODE_IDS).toEqual(['mskd', 'dev', 'cashback']);
    expect(feeMode('mskd')).toMatchObject({ quoteSymbol: 'hSOL', quoteDecimals: 9, beneficiary: 'holders' });
    expect(feeMode('dev')).toMatchObject({ quoteSymbol: 'SOL', beneficiary: 'creator' });
    expect(feeMode('cashback')).toMatchObject({ quoteSymbol: 'SOL', beneficiary: 'holders' });
    expect(feeModeByPolicy('cashback-v1')?.id).toBe('cashback');
    expect(feeModeByPolicy('bond-v1')).toBeNull();
    expect(isFeeModeId('bond')).toBe(false);
  });

  it('formats the split for display', () => {
    expect(splitRows(feeMode('dev')).map((r) => [r.label, pct(r.bps)])).toEqual([
      ['Creator', '0.60%'],
      ['House', '0.40%'],
      ['Meteora', '0.25%'],
    ]);
    expect(pct(SCHEDULE.startingFeeBps)).toBe('99%');
    expect(pct(SCHEDULE.endingFeeBps)).toBe('1.25%');
  });

  it('pairs MSKD to hSOL on mainnet and an explicit mock mint elsewhere', () => {
    expect(quoteMintFor('mskd', 'mainnet-beta')).toBe('he1iusmfkpAdwvxLNGV8Y1iSbj4rUy6yMhEA3fotn9A');
    expect(quoteMintFor('mskd', 'devnet')).toBeNull();
    expect(quoteMintFor('mskd', 'devnet', { MSKD_DEVNET_QUOTE_MINT: 'Mock111' })).toBe('Mock111');
    expect(quoteMintFor('dev', 'devnet')).toBe('So11111111111111111111111111111111111111112');
  });
});
