import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHART_PREFERENCES,
  parseChartPreferences,
  retainChartRange,
} from './chartPreferences';

describe('chart settings and viewport', () => {
  it('restores supported settings and rejects malformed or oversized storage', () => {
    const settings = {
      interval: 1,
      style: 'line',
      metric: 'price',
      currency: 'USD',
      volume: false,
      logarithmic: true,
    };
    expect(parseChartPreferences(JSON.stringify(settings))).toEqual(settings);
    for (const input of [null, '{}', '{broken', '[]', 'null', 'x'.repeat(2049)])
      expect(parseChartPreferences(input)).toEqual(DEFAULT_CHART_PREFERENCES);
    expect(
      parseChartPreferences(
        JSON.stringify({ interval: -1, currency: 'BTC', volume: 'yes', logarithmic: 1 })
      )
    ).toEqual(DEFAULT_CHART_PREFERENCES);
  });
  it('holds zoom and a panned window as new live candles arrive', () => {
    expect(retainChartRange([1, 2, 3], [1, 2, 3, 4], { from: -0.5, to: 1.5 }, false)).toEqual({
      from: -0.5,
      to: 1.5,
    });
    expect(retainChartRange([1, 2, 3], [1, 2, 3, 4], { from: -2, to: 6 }, true)).toEqual({
      from: -1,
      to: 7,
    });
  });
  it('anchors to the same timestamp when polling adds older history or trims a bounded feed', () => {
    expect(retainChartRange([3, 4, 5], [1, 2, 3, 4, 5, 6], { from: 0.5, to: 1.5 }, false)).toEqual({
      from: 2.5,
      to: 3.5,
    });
    expect(retainChartRange([1, 2, 3, 4], [2, 3, 4, 5], { from: 1.2, to: 2.2 }, false)).toEqual({
      from: 0.19999999999999996,
      to: 1.2000000000000002,
    });
  });
  it('creates a useful initial live range and handles empty data', () => {
    expect(retainChartRange([], [100], null, true)).toEqual({ from: -1, to: 4 });
    expect(retainChartRange([1], [], { from: 0, to: 4 }, false)).toBeNull();
  });
});
