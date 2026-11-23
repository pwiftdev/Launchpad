import { describe, it, expect, vi } from 'vitest';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
vi.mock('@/hooks/useNow', () => ({ useNow: () => 1000 }));
import { TaxBadge } from '../components/coin/TaxBadge';
import { TaxBanner } from '../components/coinpage/TaxBanner';
vi.stubGlobal('React', React);
describe('coin-specific fee policy labels', () => {
  it('shows the current schedule only for reviewed current coins or explicit demo fixtures', () => {
    const current = renderToStaticMarkup(
      createElement(TaxBadge, { launchedAt: 1000, feePolicyVersion: 'rinse-v1' })
    );
    const example = renderToStaticMarkup(
      createElement(TaxBadge, { launchedAt: 1000, isDemo: true })
    );
    expect(current).toContain('90%');
    expect(
      renderToStaticMarkup(
        createElement(TaxBadge, { launchedAt: 1000, feePolicyVersion: 'wallet-v1' })
      )
    ).toContain('90%');
    expect(example).toContain('90%');
    const graduated = renderToStaticMarkup(
      createElement(TaxBanner, { launchedAt: 1000, feePolicyVersion: 'rinse-v1', isMigrated: true })
    );
    expect(graduated).toContain('Snipe tax over');
  });
  it('never applies current tax percentages to legacy or unknown live coins', () => {
    for (const feePolicyVersion of ['legacy-devnet', undefined] as const) {
      const badge = renderToStaticMarkup(
          createElement(TaxBadge, { launchedAt: 1000, feePolicyVersion })
        ),
        banner = renderToStaticMarkup(
          createElement(TaxBanner, { launchedAt: 1000, feePolicyVersion })
        );
      expect(badge).toMatch(/Legacy fees|See quote/);
      expect(banner).toContain('live quote');
      expect(badge + banner).not.toContain('90%');
      expect(badge + banner).not.toContain('1.25%');
    }
  });
});
