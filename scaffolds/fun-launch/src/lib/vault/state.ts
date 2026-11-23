import { PublicKey } from '@solana/web3.js';

function header(input: Uint8Array, magic: string, minimum: number): Buffer {
  const data = Buffer.from(input);
  if (data.length < minimum || data.subarray(0, 8).toString('ascii') !== magic || data[8] !== 1)
    throw new Error('Unsupported vault account');
  return data;
}
const key = (data: Buffer, offset: number) => new PublicKey(data.subarray(offset, offset + 32));
export function decodeVaultSettings(input: Uint8Array) {
  const data = header(input, 'RSET0001', 107);
  if (data[10] !== 0 && data[10] !== 1) throw new Error('Invalid pause state');
  return {
    paused: data[10] === 1,
    governor: key(data, 11),
    operator: key(data, 43),
    treasury: key(data, 75),
  };
}
export function decodeVaultCoin(input: Uint8Array) {
  const data = header(input, 'RCOIN001', 347);
  if (data[10] !== 0 && data[10] !== 1) throw new Error('Invalid launch mode');
  return {
    mode: data[10] === 0 ? ('creator' as const) : ('community' as const),
    mint: key(data, 11),
    pool: key(data, 43),
    config: key(data, 75),
    creator: key(data, 107),
    activationTime: data.readBigInt64LE(139),
    rinseBuyback: data.readBigUInt64LE(147),
    creatorRewards: data.readBigUInt64LE(155),
    communityRewards: data.readBigUInt64LE(163),
    platformFees: data.readBigUInt64LE(171),
    nonce: data.readBigUInt64LE(179),
    burned: data.readBigUInt64LE(187),
    migratedPool: key(data, 195),
    position: key(data, 227),
    nftTokenAccount: key(data, 259),
    configHash: data.subarray(291, 323).toString('hex'),
    rinseNet: data.readBigUInt64LE(323),
    postNet: data.readBigUInt64LE(331),
    unallocatedCollected: data.readBigUInt64LE(339),
  };
}
export function decodeVaultEpoch(input: Uint8Array) {
  const data = header(input, 'REPOCH01', 138);
  return {
    coin: key(data, 10),
    epoch: data.readBigUInt64LE(42),
    root: data.subarray(50, 82).toString('hex'),
    snapshotSlot: data.readBigUInt64LE(82),
    snapshotDigest: data.subarray(90, 122).toString('hex'),
    total: data.readBigUInt64LE(122),
    remaining: data.readBigUInt64LE(130),
  };
}
export function decodeVaultFunding(input: Uint8Array) {
  const data = header(input, 'RFUND001', 138);
  return {
    coin: key(data, 10),
    fundingId: data.subarray(42, 74).toString('hex'),
    commitment: data.subarray(74, 106).toString('hex'),
    total: data.readBigUInt64LE(106),
    slot: data.readBigUInt64LE(114),
    rinseNetBefore: data.readBigUInt64LE(122),
    postNetBefore: data.readBigUInt64LE(130),
  };
}
