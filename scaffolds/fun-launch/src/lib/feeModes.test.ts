import { describe, expect, it } from 'vitest';
import {
  BENEFICIARY_NET_BPS,
  CREATOR_SHARE_OPTIONS,
  DEFAULT_CREATOR_SHARE_BPS,
  FEE_MODE_IDS,
  HSOL_MODES,
  LAUNCH_FEE_MODE,
  SCHEDULE,
  SPLIT,
  feeMode,
  feeModeByPolicy,
  isCreatorShareBps,
  isFeeModeId,
  isLaunchFeeMode,
  netShares,
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

  it('keeps the retired modes readable for registered coins', () => {
    expect([...HSOL_MODES]).toEqual(['mskd-hsol', 'hsol', 'cashback-hsol']);
    expect(feeMode('cashback-hsol').payoutSymbol).toBe('hSOL');
    expect(feeMode('mskd-hsol').payoutSymbol).toBe('wXMR');
    expect(FEE_MODE_IDS).toContain('hsol');
    expect(feeMode('hsol')).toMatchObject({
      quoteSymbol: 'hSOL',
      payoutSymbol: 'hSOL',
      bondingTarget: 80,
      beneficiary: 'creator',
    });
    expect(feeMode('mskd')).toMatchObject({
      quoteSymbol: 'SOL',
      payoutSymbol: 'wXMR',
      payoutName: 'Monero',
      beneficiary: 'holders',
    });
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

  it('pins the quote and reward mints independently for SOL, hSOL and wXMR', () => {
    for (const id of ['masked', 'mskd', 'dev', 'cashback'] as const)
      expect(quoteMintFor(id)).toBe('So11111111111111111111111111111111111111112');
    expect(quoteMintFor('hsol')).toBe('he1iusmfkpAdwvxLNGV8Y1iSbj4rUy6yMhEA3fotn9A');
    expect(payoutMintFor('hsol', 'mainnet-beta')).toBe(quoteMintFor('hsol'));
    expect(payoutMintFor('mskd', 'mainnet-beta')).toBe(
      'WXMRyRZhsa19ety5erZhHg4N3xj3EVN92u94422teJp'
    );
    expect(payoutMintFor('mskd', 'devnet')).toBeNull();
    expect(payoutMintFor('mskd', 'devnet', { MSKD_DEVNET_PAYOUT_MINT: 'Mock111' })).toBe('Mock111');
    expect(payoutMintFor('cashback', 'mainnet-beta')).toBe(
      'So11111111111111111111111111111111111111112'
    );
  });

  it('launches new coins only as Masked, paired with SOL', () => {
    expect(LAUNCH_FEE_MODE).toBe('masked');
    expect(isLaunchFeeMode('masked')).toBe(true);
    for (const id of FEE_MODE_IDS.filter((id) => id !== 'masked'))
      expect(isLaunchFeeMode(id)).toBe(false);
    expect(feeMode('masked')).toMatchObject({
      policyVersion: 'masked-v1',
      quoteSymbol: 'SOL',
      beneficiary: 'split',
      beneficiaryLabel: 'Creator and holders',
    });
  });

  it('splits every Masked 1.25% as Meteora 0.25, treasury 0.30, $MSKD 0.10, creator and holders 0.60', () => {
    const { split } = feeMode('masked');
    expect(split).toEqual({ meteoraBps: 25, houseBps: 30, buybackBps: 10, beneficiaryBps: 60 });
    expect(split.meteoraBps + split.houseBps + split.buybackBps + split.beneficiaryBps).toBe(
      SCHEDULE.endingFeeBps
    );
    expect(netShares('masked')).toEqual({ beneficiary: 6000, buyback: 1000 });
    expect(netShares('dev')).toEqual({ beneficiary: 6000, buyback: 0 });
  });

  it('accepts the creator share only in 10% steps from 0 to 100%', () => {
    expect(CREATOR_SHARE_OPTIONS).toEqual([
      0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10_000,
    ]);
    expect(isCreatorShareBps(DEFAULT_CREATOR_SHARE_BPS)).toBe(true);
    for (const bad of [-1000, 500, 10_001, 11_000, 1000.5, Number.NaN, '1000', null])
      expect(isCreatorShareBps(bad)).toBe(false);
  });

  it('shows a Masked coin as creator, holders, treasury, buyback and Meteora rows', () => {
    expect(splitRows(feeMode('masked'), 3000).map((r) => [r.label, pct(r.bps)])).toEqual([
      ['Creator', '0.18%'],
      ['Holders', '0.42%'],
      ['Masked treasury', '0.30%'],
      ['$MSKD buyback and burn', '0.10%'],
      ['Meteora', '0.25%'],
    ]);
    expect(splitRows(feeMode('masked')).at(0)).toMatchObject({
      label: 'Creator and holders',
      bps: 60,
    });
  });
});
