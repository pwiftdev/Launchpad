import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  accessPath,
  launchpadIsPublic,
  launchpadPage,
  publicApi,
  publicPage,
} from './accessRoutes';
beforeEach(() => vi.stubEnv('LAUNCHPAD_PUBLIC', ''));
afterEach(() => vi.unstubAllEnvs());

describe('private preview access', () => {
  it('allows the privacy notice, private login and brand assets', () => {
    for (const path of [
      '/privacy',
      '/admin',
      '/logo.svg',
      '/brand/mskd-mark.webp',
      '/brand/mskd-wordmark.webp',
      '/brand/mskd-favicon-32.png',
      '/favicon.ico',
    ])
      expect(publicPage(path)).toBe(true);
    for (const path of [
      '/',
      '/launch',
      '/launch-preview',
      '/otc',
      '/burns',
      '/rules',
      '/roadmap',
      '/token/test',
      '/whitelist/launch',
      '/demo/coin.svg',
      '/admin/launch',
    ])
      expect(publicPage(path)).toBe(false);
  });
  it('keeps all trading and market data private, including prefix lookalikes', () => {
    for (const path of [
      '/api/admin/session',
      '/api/health',
      '/api/og/brand',
      '/api/og/plzzz',
      '/api/og/rinsed',
    ])
      expect(publicApi(path)).toBe(true);
    for (const path of [
      '/api/coins',
      '/api/upload',
      '/api/swap-tx',
      '/api/send-transaction',
      '/api/whitelist',
      '/api/whitelist/coins',
      '/api/og/token',
      '/api/profiles',
      '/api/profiles/admin',
      '/api/callouts',
      '/api/launch-previews',
      '/api/otc',
    ])
      expect(publicApi(path)).toBe(false);
  });
  it('maps framework data requests to the protected page instead of allowing the whole prefix', () => {
    expect(accessPath('/_next/data/build/index.json')).toBe('/');
    expect(publicPage('/_next/data/build/launch.json')).toBe(false);
    expect(publicPage('/_next/data/build/token/example.json')).toBe(false);
    expect(publicPage('/_next/data/build/admin.json')).toBe(true);
  });
});

describe('public launchpad admission', () => {
  const mint = 'So11111111111111111111111111111111111111112';
  it('reads only an explicit runtime flag and closes again without a rebuild', () => {
    for (const value of ['', 'false', 'TRUE', '1']) {
      vi.stubEnv('LAUNCHPAD_PUBLIC', value);
      expect(launchpadIsPublic()).toBe(false);
      expect(publicPage('/launch')).toBe(false);
    }
    vi.stubEnv('LAUNCHPAD_PUBLIC', 'true');
    expect(publicPage('/launch')).toBe(true);
    expect(publicApi('/api/swap-tx')).toBe(true);
    vi.stubEnv('LAUNCHPAD_PUBLIC', 'false');
    expect(publicPage('/launch')).toBe(false);
    expect(publicApi('/api/swap-tx')).toBe(false);
  });
  it('opens known documents and checked-in artwork without exposing other paths', () => {
    vi.stubEnv('LAUNCHPAD_PUBLIC', 'true');
    for (const path of [
      '/',
      '/launch',
      '/rules',
      '/roadmap',
      '/404',
      `/token/${mint}`,
      '/coins/unknown.svg',
      '/demo/coins/bubble-cat.webp',
      '/brand/mskd-mark.webp',
    ])
      expect(publicPage(path)).toBe(true);
    for (const path of [
      '/launch/admin',
      '/launch-preview',
      '/otc',
      '/burns',
      '/admin/wallet',
      '/unknown',
      '/token/test',
      '/token/' + '1'.repeat(44),
      '/token/' + mint + '/withdraw',
      '/demo/coins/config.json',
      '/demo/coins/not-checked-in.webp',
      '/brand/secret.json',
    ])
      expect(publicPage(path)).toBe(false);
    expect(launchpadPage('/admin')).toBe(false);
    expect(launchpadPage('/whitelist')).toBe(false);
  });
  it('opens exactly the existing user APIs, including known token children', () => {
    vi.stubEnv('LAUNCHPAD_PUBLIC', 'true');
    for (const path of [
      '/api/coins',
      '/api/trending',
      '/api/market-stats',
      '/api/solana-market',
      '/api/sol-price',
      '/api/quote',
      '/api/swap-tx',
      '/api/send-transaction',
      '/api/transaction-status',
      '/api/rewards',
      '/api/live',
      '/api/upload',
      '/api/dev-buy-quote',
      '/api/launch/status',
      '/api/launch/confirm',
      '/api/launch/receipt-status',
      '/api/launch/migrate',
      '/api/launch/confirm-migration',
      `/api/coins/${mint}`,
      `/api/coins/${mint}/trades`,
      `/api/coins/${mint}/holders`,
      `/api/coins/${mint}/live`,
      `/api/coins/${mint}/balance`,
      `/api/og/${mint}`,
    ])
      expect(publicApi(path)).toBe(true);
    for (const path of [
      '/api/admin/wallet',
      '/api/admin/config',
      '/api/wallet/withdraw',
      '/api/launch/admin',
      '/api/launch-check',
      '/api/coins/admin',
      '/api/coins/' + mint + '/withdraw',
      '/api/rewards/admin',
      '/api/upload/secret',
      '/api/profiles/export',
      '/api/og/test',
      '/api/unknown',
      '/api/otc',
      '/api/burns',
      '/api/callouts',
      '/api/profiles',
      '/api/token-chat',
      '/api/launch-previews',
    ])
      expect(publicApi(path)).toBe(false);
  });
  it('normalizes Next data requests with the same exact document allowlist', () => {
    vi.stubEnv('LAUNCHPAD_PUBLIC', 'true');
    expect(publicPage('/_next/data/build/index.json')).toBe(true);
    expect(publicPage('/_next/data/build/roadmap.json')).toBe(true);
    expect(publicPage('/_next/data/build/rules.json')).toBe(true);
    expect(publicPage('/_next/data/build/otc.json')).toBe(false);
    expect(publicPage(`/_next/data/build/token/${mint}.json?query=1`)).toBe(true);
    expect(publicPage('/_next/data/build/admin/wallet.json')).toBe(false);
    expect(publicPage('/_next/data/build/unknown.json')).toBe(false);
  });
});
