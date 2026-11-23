import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

it('renders the same financial numbers with a different browser default locale', async () => {
  const original = Intl.NumberFormat;
  vi.spyOn(Intl, 'NumberFormat').mockImplementation(function (locales, options) {
    return new original(locales ?? 'sl-SI', options);
  });
  vi.resetModules();
  const { formatReadableNumber } = await import('./number');
  expect(formatReadableNumber(31)).toBe('31.00');
  expect(formatReadableNumber(1234)).toBe('1.23K');
});
