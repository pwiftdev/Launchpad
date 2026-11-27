// Monero address checks: Monero's block base58, the network prefix and the Keccak checksum.
// A payout is only queued to an address that passes all three, so a typo cannot lose funds.
import { keccak_256 } from '@noble/hashes/sha3';

export type MoneroNetwork = 'mainnet' | 'stagenet' | 'testnet';
export type MoneroAddressKind = 'standard' | 'subaddress' | 'integrated';

const PREFIXES: Record<MoneroNetwork, Record<MoneroAddressKind, number>> = {
  mainnet: { standard: 18, integrated: 19, subaddress: 42 },
  testnet: { standard: 53, integrated: 54, subaddress: 63 },
  stagenet: { standard: 24, integrated: 25, subaddress: 36 },
};
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** Encoded characters for a block of 0..8 bytes. */
const ENCODED_BLOCK = [0, 2, 3, 5, 6, 7, 9, 10, 11];

function decodeBlock(block: string): Uint8Array {
  const size = ENCODED_BLOCK.indexOf(block.length);
  if (size <= 0) throw new Error('Invalid Monero base58 block');
  let value = 0n;
  for (const character of block) {
    const digit = ALPHABET.indexOf(character);
    if (digit < 0) throw new Error('Invalid Monero base58 character');
    value = value * 58n + BigInt(digit);
  }
  if (value >= 1n << BigInt(size * 8)) throw new Error('Monero base58 block overflow');
  const bytes = new Uint8Array(size);
  for (let i = size - 1; i >= 0; i--) {
    bytes[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return bytes;
}

function decodeBase58(text: string): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (let offset = 0; offset < text.length; offset += 11)
    blocks.push(decodeBlock(text.slice(offset, offset + 11)));
  const out = new Uint8Array(blocks.reduce((sum, block) => sum + block.length, 0));
  let at = 0;
  for (const block of blocks) {
    out.set(block, at);
    at += block.length;
  }
  return out;
}

function encodeBlock(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let text = '';
  for (let i = 0; i < ENCODED_BLOCK[bytes.length]!; i++) {
    text = ALPHABET[Number(value % 58n)] + text;
    value /= 58n;
  }
  return text;
}

/** Monero's base58: 8-byte blocks, each always written as 11 characters except the last. */
export function encodeMoneroBase58(bytes: Uint8Array): string {
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 8)
    text += encodeBlock(bytes.subarray(offset, offset + 8));
  return text;
}

function readVarint(bytes: Uint8Array): { value: number; length: number } {
  let value = 0,
    shift = 0;
  for (let i = 0; i < Math.min(bytes.length, 4); i++) {
    value |= (bytes[i]! & 0x7f) << shift;
    if (!(bytes[i]! & 0x80)) return { value, length: i + 1 };
    shift += 7;
  }
  throw new Error('Invalid Monero address prefix');
}

/** The address's kind on the given network, or null when it is not a valid address there. */
export function moneroAddressKind(
  address: string,
  network: MoneroNetwork
): MoneroAddressKind | null {
  if (typeof address !== 'string' || (address.length !== 95 && address.length !== 106)) return null;
  try {
    const bytes = decodeBase58(address);
    const body = bytes.subarray(0, bytes.length - 4),
      checksum = bytes.subarray(bytes.length - 4);
    const expected = keccak_256(body).subarray(0, 4);
    if (!checksum.every((byte, index) => byte === expected[index])) return null;
    const { value, length } = readVarint(body);
    const kind = (Object.keys(PREFIXES[network]) as MoneroAddressKind[]).find(
      (candidate) => PREFIXES[network][candidate] === value
    );
    if (!kind) return null;
    // Two 32-byte public keys, plus an 8-byte payment ID for integrated addresses.
    const keys = body.length - length;
    if (keys !== (kind === 'integrated' ? 72 : 64)) return null;
    return kind;
  } catch {
    return null;
  }
}

export const isMoneroAddress = (address: string, network: MoneroNetwork) =>
  moneroAddressKind(address, network) !== null;

/** Builds an address from raw parts; used to create test vectors. */
export function moneroAddressFrom(prefix: number, keys: Uint8Array): string {
  const varint: number[] = [];
  let value = prefix;
  while (value >= 0x80) {
    varint.push((value & 0x7f) | 0x80);
    value >>= 7;
  }
  varint.push(value);
  const body = new Uint8Array([...varint, ...keys]);
  const checksum = keccak_256(body).subarray(0, 4);
  return encodeMoneroBase58(new Uint8Array([...body, ...checksum]));
}

/** Piconero per XMR. */
export const PICONERO = 1_000_000_000_000n;
export function formatXmr(atomic: bigint, digits = 6) {
  const whole = atomic / PICONERO,
    fraction = (atomic % PICONERO).toString().padStart(12, '0').slice(0, digits);
  return `${whole}.${fraction}`.replace(/\.?0+$/, '') || '0';
}
