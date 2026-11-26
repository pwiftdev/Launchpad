import { z } from 'zod';
import { type OtcOffer, OTC_WALLET_HEADER } from './otc';
import { socialRequest } from './profiles';

export const OTC_RINGS_API = '/api/otc-rings';
export const OTC_RINGS_RPC = '/api/otc-rings-rpc';
export const ringsSide = z.enum(['maker', 'taker']);
export type RingsSide = z.infer<typeof ringsSide>;
export const otherRingsSide = (side: RingsSide) => (side === 'maker' ? 'taker' : 'maker');

export const ringsAddress = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
export const ringsSignature = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
export const wireBytes = (length: number) => z.base64().max(length);
export const ringsLifetime = z.strictObject({
  blockhash: ringsAddress,
  lastValidBlockHeight: z.string().regex(/^\d{1,16}$/),
});
export const ringsFunding = ringsLifetime.extend({
  transaction: wireBytes(1644),
  signature: ringsSignature,
  registerToken: z.literal(true).optional(),
});
export const ringsWithdrawal = ringsFunding.extend({ transaction: wireBytes(5464) });
export const ringsPartial = z.strictObject({ message: wireBytes(5464), signature: wireBytes(88) });
export const ringsAttempt = z.strictObject({
  id: z.uuid(),
  lifetime: ringsLifetime,
  maker: ringsPartial.nullable(),
  taker: ringsPartial.nullable(),
});
export const ringsParty = z.strictObject({
  key: wireBytes(180).nullable(),
  funding: ringsFunding.nullable(),
  proof: z.string().max(12000).nullable(),
  withdrawal: ringsWithdrawal.nullable().default(null),
  reserve: ringsWithdrawal.nullable().default(null),
});
export const ringsState = z.strictObject({
  maker: ringsParty,
  taker: ringsParty,
  attempt: ringsAttempt.nullable(),
});

export type RingsFunding = z.infer<typeof ringsFunding>;
export type RingsAttempt = z.infer<typeof ringsAttempt>;
export type RingsPartial = z.infer<typeof ringsPartial>;
export type RingsState = z.infer<typeof ringsState>;
export type RingsRoom = OtcOffer &
  RingsState & { id: string; genesis: string; origin: string; side: RingsSide; localUsdc?: string };
export type RingsRoomLink = OtcOffer & { id: string; side: RingsSide };

export function ringsRequest<T>(body: object, wallet: string, signal: AbortSignal): Promise<T> {
  return socialRequest(OTC_RINGS_API, body, { [OTC_WALLET_HEADER]: wallet }, signal);
}
