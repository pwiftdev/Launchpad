import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Coin } from '@/lib/coin';
import { MskdV1Badge } from './MskdV1Badge';

const fixture = vi.hoisted(() => ({ network: 'mainnet-beta' }));
vi.mock('@/constants/network', () => ({
  get NETWORK() {
    return fixture.network;
  },
}));
beforeEach(() => {
  fixture.network = 'mainnet-beta';
  vi.stubGlobal('React', React);
});
afterEach(() => vi.unstubAllGlobals());
const render = (coin: Partial<Coin>) =>
  renderToStaticMarkup(createElement(MskdV1Badge, { coin: coin as Coin }));

describe('MSKDv1 label', () => {
  it.each(['dev-v1', 'mskd-v1', 'bond-v1'] as const)(
    'marks previous mainnet launches (%s)',
    (feePolicyVersion) => {
      expect(render({ feePolicyVersion })).toContain('MSKDv1');
    }
  );
  it('leaves new Masked launches, samples and devnet launches outside the legacy label', () => {
    expect(render({ feePolicyVersion: 'masked-v1' })).toBe('');
    expect(render({})).toBe('');
    expect(render({ feePolicyVersion: 'dev-v1', isDemo: true })).toBe('');
    fixture.network = 'devnet';
    expect(render({ feePolicyVersion: 'dev-v1' })).toBe('');
  });
});
