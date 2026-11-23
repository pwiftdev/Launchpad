import { describe, expect, it } from 'vitest';
import { findNameCopy, hashDistance, nameCore, parseSourcePost } from './rules';

describe('nameCore', () => {
  it('drops copy words and folds lookalikes', () => {
    expect(nameCore('Pepe Official')).toBe('PEPE');
    expect(nameCore('Real PEPE')).toBe('PEPE');
    expect(nameCore('Pepe v2')).toBe('PEPE');
    expect(nameCore('P3PE 2')).toBe('PEPE');
    expect(nameCore('Dog Wif Hat')).toBe('DOGWIFHAT');
  });
});

describe('findNameCopy', () => {
  const existing = ['Pepe', 'Dog Wif Hat'];

  it('flags an existing name plus official / real / 2 / v2', () => {
    expect(findNameCopy('Pepe Official', existing)).toBe('Pepe');
    expect(findNameCopy('The Real Pepe', existing)).toBe('Pepe');
    expect(findNameCopy('PEPE 2', existing)).toBe('Pepe');
    expect(findNameCopy('Pepe V2', existing)).toBe('Pepe');
    expect(findNameCopy('dog wif hat v2', existing)).toBe('Dog Wif Hat');
  });

  it('leaves new names and exact duplicates to the ticker rules', () => {
    expect(findNameCopy('Pepe Frog Club', existing)).toBeNull();
    expect(findNameCopy('Soapy', existing)).toBeNull();
    expect(findNameCopy('Pepe', existing)).toBeNull();
  });
});

describe('parseSourcePost', () => {
  it('extracts the post id from x.com and twitter.com links', () => {
    expect(parseSourcePost('https://x.com/elonmusk/status/1234567890123?s=20')).toBe(
      '1234567890123'
    );
    expect(parseSourcePost('https://twitter.com/a_b/status/987654321')).toBe('987654321');
    expect(parseSourcePost('https://mobile.x.com/a/status/55555')).toBe('55555');
  });

  it('rejects anything that is not a single post', () => {
    expect(parseSourcePost('https://x.com/elonmusk')).toBeNull();
    expect(parseSourcePost('https://example.com/a/status/12345')).toBeNull();
  });
});

describe('hashDistance', () => {
  it('counts differing bits', () => {
    expect(hashDistance('0000000000000000', '0000000000000000')).toBe(0);
    expect(hashDistance('000000000000000f', '0000000000000000')).toBe(4);
    expect(hashDistance('ffffffffffffffff', '0000000000000000')).toBe(64);
  });
});
