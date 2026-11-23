import type { NextApiRequest, NextApiResponse } from 'next';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import bs58 from 'bs58';
import { z } from 'zod';
import { apiGuard } from '@/server/apiGuard';
import { connection, networkGenesis } from '@/server/dbc';
import { verifyLaunchPreparation } from '@/server/launchPreparation';
const integer = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .refine((value) => Number.isSafeInteger(value) && value >= 0);
const input = z
  .object({
    mint: z.string().min(32).max(44),
    wallet: z.string().min(32).max(44),
    signature: z.string().min(64).max(88),
    genesis: z.string().min(32).max(44),
    preparedSlot: integer,
    lastValidBlockHeight: integer,
    blockhash: z.string().min(32).max(44),
    messageDigest: z.string().regex(/^[a-f0-9]{64}$/),
    messageBase64: z.string().min(1).max(1644),
    preparationProof: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();
/** Never infer success/failure from absence. Expiry needs authenticated preparation and absent mint. */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!apiGuard(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const parsed = input.safeParse(req.query);
  if (!parsed.success)
    return res
      .status(400)
      .json({ error: 'A complete saved preparation context is required for expiry checks' });
  const context = {
    ...parsed.data,
    preparedSlot: Number(parsed.data.preparedSlot),
    lastValidBlockHeight: Number(parsed.data.lastValidBlockHeight),
  };
  try {
    if (bs58.decode(context.signature).length !== 64) throw new Error();
    verifyLaunchPreparation(context);
  } catch {
    return res.status(400).json({
      error:
        'Saved preparation context could not be authenticated. Registration can still be checked.',
    });
  }
  try {
    if ((await networkGenesis(true)) !== context.genesis)
      return res.status(409).json({
        error:
          'This receipt belongs to another network. Keep it and reconnect to its original network.',
      });
    const [statuses, epoch, firstAvailable] = await Promise.all([
      connection.getSignatureStatuses([context.signature], { searchTransactionHistory: true }),
      connection.getEpochInfo({ commitment: 'finalized', minContextSlot: context.preparedSlot }),
      connection.getFirstAvailableBlock(),
    ]);
    if (
      !Number.isSafeInteger(epoch.absoluteSlot) ||
      epoch.absoluteSlot < context.preparedSlot ||
      typeof epoch.blockHeight !== 'number' ||
      !Number.isSafeInteger(epoch.blockHeight) ||
      epoch.blockHeight < 0 ||
      !Number.isSafeInteger(firstAvailable) ||
      firstAvailable < 0
    )
      throw new Error('Invalid finalized expiry bank');
    const status = statuses.value[0],
      minimumSlot = Math.max(epoch.absoluteSlot, status?.slot ?? 0);
    const [mint, finalizedHash, confirmedHash] = await Promise.all([
      connection.getAccountInfoAndContext(new PublicKey(context.mint), {
        commitment: 'finalized',
        minContextSlot: minimumSlot,
      }),
      connection.isBlockhashValid(context.blockhash, {
        commitment: 'finalized',
        minContextSlot: minimumSlot,
      }),
      connection.isBlockhashValid(context.blockhash, {
        commitment: 'confirmed',
        minContextSlot: minimumSlot,
      }),
    ]);
    // Harmless System-owned zero-data dust is not an initialized SPL mint.
    const uninitialized =
      mint.value === null ||
      (!mint.value.executable &&
        mint.value.owner.equals(SystemProgram.programId) &&
        mint.value.data.length === 0);
    const retained = firstAvailable <= context.preparedSlot,
      missingMint = uninitialized && mint.context.slot >= minimumSlot;
    const failed = status?.confirmationStatus === 'finalized' && !!status.err;
    const expired =
      !status &&
      retained &&
      epoch.blockHeight > context.lastValidBlockHeight &&
      finalizedHash.value === false &&
      confirmedHash.value === false &&
      finalizedHash.context.slot >= minimumSlot &&
      confirmedHash.context.slot >= minimumSlot &&
      missingMint;
    if ((await networkGenesis(true)) !== context.genesis)
      return res
        .status(409)
        .json({ error: 'Network changed while checking this receipt. Keep the saved receipt.' });
    return res.status(200).json({
      genesis: context.genesis,
      found: !!status,
      finalized: status?.confirmationStatus === 'finalized',
      failed,
      expired,
      mintExists: !uninitialized,
      mintAccountPresent: mint.value !== null,
      historyIncomplete: !retained,
      safeToRetry: missingMint && (failed || expired),
      state: failed
        ? 'failed'
        : expired
          ? 'expired'
          : status?.confirmationStatus === 'finalized'
            ? 'finalized'
            : 'pending',
    });
  } catch {
    return res.status(503).json({
      error:
        'Receipt verification is unavailable. Keep the receipt; submission or confirmation may still be pending.',
    });
  }
}
