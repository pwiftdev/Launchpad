import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PriceChart } from './PriceChart';

beforeEach(() => vi.stubGlobal('React', React));
afterEach(() => vi.unstubAllGlobals());

const render = (props: Parameters<typeof PriceChart>[0] = {}) =>
  renderToStaticMarkup(createElement(PriceChart, props));

describe('24-hour token price chart', () => {
  it('shows loading and empty states without making up price movement', () => {
    expect(render({ isLoading: true })).toContain('Loading price history');
    expect(render({ history: { points: [] } })).toContain('Waiting for more trades');
    expect(render({ history: { points: [{ time: 100, priceSol: 1 }] } })).not.toContain(
      'role="img"'
    );
  });
  it('offers retry without exposing provider errors', () => {
    const html = render({ error: new Error('provider secret'), onRetry: () => {} });
    expect(html).toContain('Price history unavailable');
    expect(html).toContain('Retry');
    expect(html).not.toContain('provider secret');
  });
  it('keeps available prices visible when the display index is stale', () => {
    const html = render({
      history: {
        stale: true,
        points: [
          { time: 100, priceSol: 1 },
          { time: 200, priceSol: 2 },
        ],
      },
    });
    expect(html).toContain('Price updates delayed');
    expect(html).toContain('Recorded token prices in SOL');
  });
  it('positions prices using real elapsed time between trades', () => {
    const html = render({
      history: {
        points: [
          { time: 100, priceSol: 1 },
          { time: 110, priceSol: 2 },
          { time: 200, priceSol: 3 },
        ],
      },
    });
    expect(html).toContain('M6.00,194.00 L64.80,100.00 L594.00,6.00');
  });
});
