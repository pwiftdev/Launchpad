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
  payoutMintFor,
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
    expect(feeMode('mskd')).toMatchObject({ quoteSymbol: 'SOL', payoutSymbol: 'wXMR', payoutName: 'Monero', beneficiary: 'holders' });
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

  it('pairs every mode to SOL; MSKD pays holders in wXMR', () => {
    for (const id of FEE_MODE_IDS)
      expect(quoteMintFor(id)).toBe('So11111111111111111111111111111111111111112');
    expect(payoutMintFor('mskd', 'mainnet-beta')).toBe('WXMRyRZhsa19ety5erZhHg4N3xj3EVN92u94422teJp');
    expect(payoutMintFor('mskd', 'devnet')).toBeNull();
    expect(payoutMintFor('mskd', 'devnet', { MSKD_DEVNET_PAYOUT_MINT: 'Mock111' })).toBe('Mock111');
    expect(payoutMintFor('cashback', 'mainnet-beta')).toBe('So11111111111111111111111111111111111111112');
  });
});
