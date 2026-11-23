import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  buildCurve,
  calculateFeeSchedulerEndingBaseFeeBps,
  getFeeSchedulerParams,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import {
  BASE_FEE_PERCENT,
  LAUNCH_TAX_CLIFF_PERCENT,
  LAUNCH_TAX_PERIODS,
  LAUNCH_TAX_REDUCTION_BPS,
  LAUNCH_TAX_STEP_SECONDS,
  LAUNCH_TAX_WINDOW_SECONDS,
} from '@/constants/launch';
import { TAX_STEPS, taxPercentAt, taxStateAt } from './launchTax';

describe('launch tax policy', () => {
  it('shows the final fee once an early graduation reaches the migrated pool', () => {
    expect(taxStateAt(3, true)).toEqual({
      percent: BASE_FEE_PERCENT,
      nextStepIn: null,
      isClean: true,
    });
    expect(taxStateAt(3, false).isClean).toBe(false);
  });
  it('starts at 90%, reduces only at each three-second boundary, and finishes after 27s', () => {
    expect(taxPercentAt(0)).toBe(90);
    expect(taxPercentAt(2.999)).toBe(90);
    expect(taxPercentAt(-1)).toBe(90);
    for (let second = 3; second <= 27; second += 3) {
      expect(taxPercentAt(second)).toBeLessThan(taxPercentAt(second - 0.001));
    }
    expect(taxStateAt(26.999).isClean).toBe(false);
    expect(taxStateAt(27)).toEqual({ percent: taxPercentAt(27), isClean: true, nextStepIn: null });
    expect(taxPercentAt(3600)).toBe(taxPercentAt(27));
    expect(TAX_STEPS).toHaveLength(10);
  });

  it('keeps the web display and SDK-generated exponential scheduler consistent, including rounding', () => {
    const schedule = getFeeSchedulerParams(9000, 125, 1, 9, 27);
    expect(schedule.cliffFeeNumerator.toNumber()).toBe(LAUNCH_TAX_CLIFF_PERCENT * 10_000_000);
    expect(schedule.firstFactor).toBe(LAUNCH_TAX_PERIODS);
    expect(schedule.secondFactor.toNumber()).toBe(LAUNCH_TAX_STEP_SECONDS);
    expect(schedule.thirdFactor.toNumber()).toBe(LAUNCH_TAX_REDUCTION_BPS);
    const endpointBps = calculateFeeSchedulerEndingBaseFeeBps(
      schedule.cliffFeeNumerator.toNumber(),
      9,
      3,
      schedule.thirdFactor.toNumber(),
      1
    );
    expect(taxPercentAt(27)).toBeCloseTo(endpointBps / 100, 8);
    expect(taxPercentAt(27)).toBeGreaterThan(BASE_FEE_PERCENT);
    expect(taxPercentAt(27)).toBeLessThan(BASE_FEE_PERCENT + 0.001);
  });

  it('keeps the dry-run deployment template aligned before and after migration', () => {
    const file = new URL('../../../../studio/config/dbc_config.jsonc', import.meta.url);
    const parsed = ts.parseConfigFileTextToJson(file.pathname, readFileSync(file, 'utf8'));
    expect(parsed.error).toBeUndefined();
    expect(parsed.config.dryRun).toBe(true);
    const { fee, migration, activationType } = parsed.config.dbcConfig;
    expect(activationType).toBe(1);
    expect(fee.baseFeeParams.baseFeeMode).toBe(1);
    expect(fee.baseFeeParams.feeSchedulerParam).toEqual({
      startingFeeBps: LAUNCH_TAX_CLIFF_PERCENT * 100,
      endingFeeBps: BASE_FEE_PERCENT * 100,
      numberOfPeriod: LAUNCH_TAX_PERIODS,
      totalDuration: LAUNCH_TAX_WINDOW_SECONDS,
    });
    expect(fee.dynamicFeeEnabled).toBe(false);
    expect(migration.migrationOption).toBe(1);
    expect(migration.migrationFeeOption).toBe(6);
    expect(migration.migratedPoolFee).toEqual({
      collectFeeMode: 0,
      dynamicFee: 0,
      poolFeeBps: 125,
    });
    // Exercise the same builder as Studio, rather than only checking the source JSON.
    const {
      buildCurveMode,
      leftoverReceiver: _leftoverReceiver,
      feeClaimer: _feeClaimer,
      ...params
    } = parsed.config.dbcConfig;
    expect(buildCurveMode).toBe(0);
    const built = buildCurve(params);
    expect(built.poolFees.baseFee.cliffFeeNumerator.toNumber()).toBe(900_000_000);
    expect(built.poolFees.dynamicFee).toBeNull();
    expect(built.migrationFeeOption).toBe(6);
    expect(built.migratedPoolFee).toEqual({ collectFeeMode: 0, dynamicFee: 0, poolFeeBps: 125 });
    expect(built.tokenUpdateAuthority).toBe(1);
  });
});
