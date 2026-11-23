import { afterEach, describe, expect, it, vi } from 'vitest';
import { siteOrigins, siteOriginForHeaders } from './siteOrigin';

afterEach(() => vi.unstubAllEnvs());
describe('site origin allowlist', () => {
  it('keeps an explicitly configured custom domain without trusting arbitrary hosts', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://launch.example');
    vi.stubEnv('SITE_ALLOWED_ORIGINS', 'https://rinsed.fun');
    expect(siteOrigins()).toEqual(['https://launch.example', 'https://rinsed.fun']);
    expect(siteOriginForHeaders({ origin: 'https://rinsed.fun' })).toBe('https://rinsed.fun');
    expect(siteOriginForHeaders({ host: 'rinsed.fun' })).toBe('https://rinsed.fun');
    expect(siteOriginForHeaders({ host: 'attacker.example' })).toBe('https://launch.example');
    expect(siteOriginForHeaders({ origin: 'https://rinsed.fun.attacker.example' })).toBe(
      'https://launch.example'
    );
  });
});
