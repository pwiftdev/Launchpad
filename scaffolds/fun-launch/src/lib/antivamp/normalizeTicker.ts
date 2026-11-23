// Lookalike letters from other scripts mapped to the Latin capital they imitate.
// Applied after NFKC, which already folds fullwidth and mathematical letters.
const CONFUSABLES: Record<string, string> = {
  // Cyrillic
  А: 'A',
  а: 'A',
  В: 'B',
  в: 'B',
  Е: 'E',
  е: 'E',
  Ё: 'E',
  ё: 'E',
  К: 'K',
  к: 'K',
  М: 'M',
  м: 'M',
  Н: 'H',
  н: 'H',
  О: 'O',
  о: 'O',
  Р: 'P',
  р: 'P',
  С: 'C',
  с: 'C',
  Т: 'T',
  т: 'T',
  У: 'Y',
  у: 'Y',
  Х: 'X',
  х: 'X',
  Ѕ: 'S',
  ѕ: 'S',
  І: 'I',
  і: 'I',
  Ј: 'J',
  ј: 'J',
  Ԁ: 'D',
  ԁ: 'D',
  Ԛ: 'Q',
  ԛ: 'Q',
  Ԝ: 'W',
  ԝ: 'W',
  Ү: 'Y',
  ү: 'Y',
  // Greek
  Α: 'A',
  α: 'A',
  Β: 'B',
  β: 'B',
  Ε: 'E',
  ε: 'E',
  Ζ: 'Z',
  Η: 'H',
  Ι: 'I',
  ι: 'I',
  Κ: 'K',
  κ: 'K',
  Μ: 'M',
  Ν: 'N',
  ν: 'V',
  Ο: 'O',
  ο: 'O',
  Ρ: 'P',
  ρ: 'P',
  Τ: 'T',
  τ: 'T',
  Υ: 'Y',
  υ: 'Y',
  Χ: 'X',
  χ: 'X',
  // Latin lookalikes that survive NFKC
  ı: 'I',
  ȷ: 'J',
  ł: 'L',
  Ł: 'L',
  ø: 'O',
  Ø: 'O',
  đ: 'D',
  Đ: 'D',
  ħ: 'H',
  Ħ: 'H',
};

const LEET: Record<string, string> = {
  '0': 'O',
  '1': 'I',
  '3': 'E',
  '4': 'A',
  '5': 'S',
  '7': 'T',
  '@': 'A',
  $: 'S',
};

/**
 * Collapses a ticker to the form used for duplicate checks, so lookalikes such as
 * "$P3PE", "p e p e" and Cyrillic "РЕРЕ" all become "PEPE".
 */
export function normalizeTicker(input: string): string {
  // A leading "$" is the ticker sigil people type, not part of the ticker
  const withoutSigil = input.trim().replace(/^\$+/, '');

  const folded = withoutSigil
    .normalize('NFKC')
    .replace(/./gu, (ch) => CONFUSABLES[ch] ?? ch)
    // Strip accents: É -> E
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toUpperCase();

  return folded.replace(/[013457@$]/g, (ch) => LEET[ch] ?? ch).replace(/[^A-Z0-9]/g, '');
}
