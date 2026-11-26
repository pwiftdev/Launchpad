import type { NextApiRequest, NextApiResponse } from 'next';
import bs58 from 'bs58';
import { z } from 'zod';
import { decodeRingsProof } from '@/lib/otcRingsPackets';
import { dealAddress } from '@/lib/otcRingsDeposit';
import { ringsFunding, ringsPartial, ringsWithdrawal, wireBytes } from '@/lib/otcRingsRoom';
import { ringsAccess } from '@/server/otcRingsAccess';
import {
  requireSafeRetry,
  ringsConnection,
  verifyFundingPacket,
  verifyRingsQuoteReady,
} from '@/server/otcRingsRetry';
import { validateRingsSignature, validateRingsWithdrawal } from '@/server/otcRingsSignatures';
import { ProfileStore, SocialError } from '@/server/profileStore';

export const config = { api: { bodyParser: { sizeLimit: '20kb' } } };
const id = z.uuid();
const input = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('list') }),
  z.strictObject({
    action: z.literal([
      'open',
      'view',
      'attempt',
      'retry-funding',
      'retry-attempt',
      'retry-withdrawal',
      'retry-reserve',
    ]),
    id,
  }),
  z.strictObject({ action: z.literal('key'), id, key: wireBytes(180) }),
  z.strictObject({ action: z.literal('funding'), id, funding: ringsFunding }),
  z.strictObject({ action: z.literal('withdrawal'), id, withdrawal: ringsWithdrawal }),
  z.strictObject({ action: z.literal('reserve'), id, reserve: ringsWithdrawal }),
  z.strictObject({ action: z.literal('proof'), id, proof: z.string().min(1).max(12000) }),
  z.strictObject({ action: z.literal('sign'), id, attempt: z.uuid(), partial: ringsPartial }),
]);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const access = ringsAccess(req, res);
    if (!access) return;
    const parsed = input.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid OTC deal request.' });
    const { store, wallet, origin, config, genesis } = access;
    const payload = parsed.data;
    if (payload.action === 'list') return res.status(200).json(await store.list(wallet));
    if (payload.action === 'view') return res.status(200).json(await store.get(payload.id, wallet));
    if (
      !config.enabled &&
      !['withdrawal', 'retry-withdrawal', 'reserve', 'retry-reserve'].includes(payload.action)
    )
      return res
        .status(409)
        .json({ error: 'New settlement actions are paused. You can still recover funded deals.' });
    if (payload.action === 'open') {
      await new ProfileStore().limit(`otc-open:${wallet}`, 30);
      return res
        .status(200)
        .json(
          await store.openDeal(
            payload.id,
            wallet,
            origin,
            config.network === 'localnet' ? process.env.OTC_RINGS_LOCAL_USDC_MINT : undefined
          )
        );
    }
    if (payload.action === 'key') {
      try {
        if (dealAddress(payload.key).solanaAddress() === wallet) throw new Error();
      } catch {
        return res.status(400).json({ error: 'Invalid deal wallet.' });
      }
    }
    if (payload.action === 'proof') {
      try {
        decodeRingsProof(payload.proof);
      } catch {
        return res.status(400).json({ error: 'Invalid deal proof.' });
      }
    }
    if (payload.action === 'funding') {
      const room = await store.get(payload.id, wallet);
      await verifyFundingPacket(payload.funding, wallet, room);
      await verifyRingsQuoteReady(room, config.rpc);
    }
    if (payload.action === 'sign')
      await validateRingsSignature(
        await store.get(payload.id, wallet),
        payload.attempt,
        payload.partial
      );
    if (payload.action === 'withdrawal')
      await validateRingsWithdrawal(await store.get(payload.id, wallet), payload.withdrawal);
    if (payload.action === 'reserve') {
      const room = await store.get(payload.id, wallet);
      const withdrawal = room[room.side].withdrawal;
      if (!withdrawal) throw new SocialError('Withdraw from the deal first.', 409);
      const connection = ringsConnection(config.rpc);
      if ((await connection.getGenesisHash()) !== genesis)
        throw new Error('Rings RPC network mismatch');
      const { value } = await connection.getSignatureStatus(withdrawal.signature, {
        searchTransactionHistory: true,
      });
      if (value?.confirmationStatus !== 'finalized' || value.err)
        throw new SocialError('Wait for the withdrawal to finalize.', 409);
      await validateRingsWithdrawal(room, payload.reserve, wallet);
      return res.status(200).json(await store.mutate(payload.id, wallet, payload));
    }
    if (
      payload.action === 'attempt' ||
      payload.action === 'retry-funding' ||
      payload.action === 'retry-attempt' ||
      payload.action === 'retry-withdrawal' ||
      payload.action === 'retry-reserve'
    ) {
      const room = await store.get(payload.id, wallet);
      const connection = ringsConnection(config.rpc);
      if ((await connection.getGenesisHash()) !== genesis)
        throw new Error('Rings RPC network mismatch');
      if (payload.action === 'attempt') {
        if (room.attempt) return res.status(200).json(room);
        const latest = await connection.getLatestBlockhash();
        return res.status(200).json(
          await store.mutate(payload.id, wallet, {
            action: 'attempt',
            lifetime: {
              blockhash: latest.blockhash,
              lastValidBlockHeight: String(latest.lastValidBlockHeight),
            },
          })
        );
      }
      if (payload.action === 'retry-funding') {
        const funding = room[room.side].funding;
        if (!funding) return res.status(200).json(room);
        await requireSafeRetry(connection, funding, funding.signature);
        return res.status(200).json(
          await store.mutate(payload.id, wallet, {
            action: 'retry-funding',
            signature: funding.signature,
          })
        );
      }
      if (payload.action === 'retry-withdrawal' || payload.action === 'retry-reserve') {
        const pending =
          payload.action === 'retry-withdrawal'
            ? room[room.side].withdrawal
            : room[room.side].reserve;
        if (!pending) return res.status(200).json(room);
        await requireSafeRetry(connection, pending, pending.signature);
        return res.status(200).json(
          await store.mutate(payload.id, wallet, {
            action: payload.action,
            signature: pending.signature,
          })
        );
      }
      const attempt = room.attempt;
      if (!attempt) return res.status(200).json(room);
      const signature = attempt.taker
        ? bs58.encode(Buffer.from(attempt.taker.signature, 'base64'))
        : undefined;
      await requireSafeRetry(connection, attempt.lifetime, signature);
      return res
        .status(200)
        .json(
          await store.mutate(payload.id, wallet, { action: 'retry-attempt', attempt: attempt.id })
        );
    }
    if (
      payload.action === 'key' ||
      payload.action === 'funding' ||
      payload.action === 'proof' ||
      payload.action === 'sign' ||
      payload.action === 'withdrawal'
    ) {
      return res.status(200).json(await store.mutate(payload.id, wallet, payload));
    }
    return res.status(400).json({ error: 'Invalid OTC deal action.' });
  } catch (error) {
    if (error instanceof SocialError)
      return res.status(error.status).json({ error: error.message });
    console.error('Rings deal request failed');
    return res.status(503).json({ error: 'The OTC deal could not be updated.' });
  }
}
