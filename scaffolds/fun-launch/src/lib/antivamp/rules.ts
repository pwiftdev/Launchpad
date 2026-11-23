import { normalizeTicker } from './normalizeTicker';

// Words vampires bolt onto an existing coin's name: "Pepe Official", "Real Pepe", "PEPE 2", "Pepe v2"
const COPY_WORDS = new Set([
  'official',
  'real',
  'the',
  'og',
  'original',
  'new',
  'classic',
  'legit',
  'true',
  'v2',
  'v3',
  'v4',
  '2',
  '3',
  '4',
  'ii',
  'iii',
  '20',
  '2.0',
  'on',
  'sol',
  'solana',
]);

/** A name reduced to its core: lookalikes folded, copy words dropped. "PEPE Official" -> "PEPE". */
export function nameCore(name: string): string {
  return name
    .split(/[\s\-_.:|/]+/)
    .filter((word) => word && !COPY_WORDS.has(word.toLowerCase()))
    .map((word) => normalizeTicker(word))
    .join('');
}

/**
 * The existing coin name `candidate` copies, if any: same core name but not literally the same coin.
 * Exact duplicates are caught by the ticker rules; this catches "X official", "X v2" and friends.
 */
export function findNameCopy(candidate: string, existing: string[]): string | null {
  const core = nameCore(candidate);
  if (core.length < 2) return null;
  const normalizedCandidate = normalizeTicker(candidate);
  for (const name of existing) {
    if (nameCore(name) === core && normalizeTicker(name) !== normalizedCandidate) return name;
  }
  return null;
}

/** "https://x.com/user/status/123?s=20" -> "123". Accepts x.com and twitter.com post links. */
export function parseSourcePost(url: string): string | null {
  const match = url
    .trim()
    .match(
      /^https:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/status\/(\d{5,25})\/?(?:[?#].*)?$/
    );
  return match?.[1] ?? null;
}

/** Bits that differ between two 64-bit image hashes in hex. */
export function hashDistance(a: string, b: string): number {
  if (!/^[a-f0-9]{16}$/i.test(a) || !/^[a-f0-9]{16}$/i.test(b))
    throw new Error('Expected two 64-bit image hashes');
  let distance = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    let x = parseInt(a.charAt(i), 16) ^ parseInt(b.charAt(i), 16);
    while (x) {
      distance += x & 1;
      x >>= 1;
    }
  }
  return distance;
}
