import { describe, expect, it } from 'vitest';
import { normalizeTicker } from './normalizeTicker';

describe('normalizeTicker', () => {
  it('collapses the Phase 6 PEPE variants to PEPE', () => {
    for (const variant of [
      'PEPE',
      '$PEPE',
      '$P3PE',
      '$pepe',
      '$P E P E',
      'РЕРЕ',
      'pEpE',
      'P.E-P_E!',
    ]) {
      expect(normalizeTicker(variant), variant).toBe('PEPE');
    }
  });

  it('uppercases and strips spaces and punctuation', () => {
    expect(normalizeTicker('  dog wif hat ')).toBe('DOGWIFHAT');
    expect(normalizeTicker('BO-NK!')).toBe('BONK');
  });

  it('maps leetspeak digits and symbols', () => {
    expect(normalizeTicker('B0NK')).toBe('BONK');
    expect(normalizeTicker('5H1B')).toBe('SHIB');
    expect(normalizeTicker('W1F')).toBe('WIF');
    expect(normalizeTicker('M3M3')).toBe('MEME');
    expect(normalizeTicker('4P3')).toBe('APE');
    expect(normalizeTicker('7RUMP')).toBe('TRUMP');
    expect(normalizeTicker('@PE')).toBe('APE');
  });

  it('treats only a leading $ as the sigil and maps any other $ to S', () => {
    expect(normalizeTicker('$$WIF')).toBe('WIF');
    expect(normalizeTicker('$HIB')).toBe('HIB');
    expect(normalizeTicker('B$NK')).toBe('BSNK');
    expect(normalizeTicker('$ $HIB')).toBe('SHIB');
  });

  it('maps Cyrillic and Greek lookalikes to Latin', () => {
    expect(normalizeTicker('ВОNК')).toBe('BONK'); // Cyrillic В, О, К
    expect(normalizeTicker('ΑΡΕ')).toBe('APE'); // Greek Alpha, Rho, Epsilon
    expect(normalizeTicker('рере')).toBe('PEPE'); // lowercase Cyrillic
  });

  it('folds fullwidth, mathematical and accented letters', () => {
    expect(normalizeTicker('ＰＥＰＥ')).toBe('PEPE');
    expect(normalizeTicker('𝐏𝐄𝐏𝐄')).toBe('PEPE');
    expect(normalizeTicker('PÉPÉ')).toBe('PEPE');
  });

  it('keeps digits that are not leetspeak', () => {
    expect(normalizeTicker('PEPE2')).toBe('PEPE2');
    expect(normalizeTicker('GME69')).toBe('GME69');
  });

  it('returns an empty string when nothing is left', () => {
    expect(normalizeTicker('$')).toBe('');
    expect(normalizeTicker(' -!- ')).toBe('');
  });
});
