import { hasCreatorRewards, isWalletPolicy } from '@/lib/launchModes';
import { createHash } from 'node:crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';
import { apiGuard, takeLimit } from '@/server/apiGuard';
import { connection, networkGenesis } from '@/server/dbc';
import { assertWalletExecutionGate } from '@/server/economics/walletGate';
import {
  assertWalletRecipientCredit,
  WalletRecipientUnavailable,
} from '@/server/economics/walletRecipient';
import { registeredCoin } from '@/server/launchRegistry';
import { siteOriginForHeaders } from '@/server/siteOrigin';
import { verifyClaimAuthorization } from '@/server/economics/claimAuthorization';
import { WalletStore, type WalletJob } from '@/server/economics/walletStore';
import { claimAuthorizationMessage, type RewardsView } from '@/lib/rewards';

export const config = { api: { bodyParser: { sizeLimit: '3kb' } } };
const address = z
  .string()
  .min(32)
  .max(44)
  .refine((value) => {
    try {
      return new PublicKey(value).toBase58() === value;
    } catch {
      return false;
    }
  });
const epoch = z.string().regex(/^(0|[1-9]\d{0,9})$/);
const query = z
  .object({
    mint: address,
    wallet: address,
    beforeEpoch: epoch.optional(),
    requestId: z.string().uuid().optional(),
  })
  .strict();
const prepare = z
  .object({
    action: z.literal('prepare'),
    networkGenesis: address,
    mint: address,
    wallet: address,
    epoch: epoch.nullable(),
    amount: z
      .string()
      .regex(/^[1-9]\d{0,19}$/)
      .refine((value) => /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n),
    requestId: z.string().uuid(),
    issuedAt: z.number().int(),
    signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
  })
  .strict();
const check = z
  .object({
    action: z.enum(['settle', 'recover']),
    id: z.string().uuid(),
    networkGenesis: address,
    mint: address,
    wallet: address,
  })
  .strict();
/** Public receipts contain no signer material or serialized transaction. */
const safeJob = (job: WalletJob, requestId?: string) => ({
  id: job.id,
  status: job.status,
  signature: job.signature,
  amount: job.lamports,
  ...(requestId ? { requestId } : {}),
});

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!apiGuard(req, res)) return;
  res.setHeader('Cache-Control', 'private, no-store');
  if (!['GET', 'POST'].includes(req.method ?? ''))
    return res.status(405).json({ error: 'Method not allowed' });
  let reservationAttempted = false;
  try {
    const genesis = await networkGenesis(true),
      store = new WalletStore();
    if (req.method === 'GET') {
      const input = query.safeParse(req.query);
      if (!input.success) return res.status(400).json({ error: 'Invalid reward query' });
      const coin = await registeredCoin(genesis, input.data.mint);
      const empty: RewardsView = {
        networkGenesis: genesis,
        payoutMethod: 'server-paid',
        status: 'unavailable',
        mode: coin?.mode ?? null,
        availableLamports: '0',
        epochs: [],
      };
      if (!coin || !isWalletPolicy(coin.policy_version)) return res.status(200).json(empty);
      const view = await store.rewardsView({
        networkGenesis: genesis,
        mint: coin.mint,
        wallet: input.data.wallet,
        ...(input.data.beforeEpoch === undefined
          ? {}
          : { beforeEpoch: Number(input.data.beforeEpoch) }),
        limit: 11,
      });
      const request = input.data.requestId
        ? await store.payoutForRequest(genesis, coin.mint, input.data.wallet, input.data.requestId)
        : null;
      if ((await networkGenesis(true)) !== genesis)
        throw new Error('Network changed during reward lookup');
      const rows = view.epochs.slice(0, 10);
      return res.status(200).json({
        ...empty,
        status: 'ready',
        availableLamports:
          coin.mode === 'community'
            ? rows
                .filter((row) => row.status === 'available')
                .reduce((sum, row) => sum + BigInt(row.lamports), 0n)
                .toString()
            : view.availableLamports,
        paidLamports: view.paidLamports,
        creatorReceipts: view.receipts,
        creatorJob: view.pendingPayout ? safeJob(view.pendingPayout) : null,
        request: request ? safeJob(request, input.data.requestId) : null,
        nextEpoch: view.epochs.length > 10 ? rows.at(-1)!.epoch : null,
        epochs: rows.map((row) => ({
          epoch: row.epoch,
          lamports: row.lamports,
          status: row.status === 'queued' ? 'pending' : row.status,
          jobId: row.jobId,
          signature: row.signature ?? null,
        })),
      });
    }
    const prepared = prepare.safeParse(req.body);
    if (prepared.success) {
      const input = { ...prepared.data, epoch: prepared.data.epoch ?? null },
        origin = siteOriginForHeaders(req.headers);
      if (input.networkGenesis !== genesis)
        return res
          .status(409)
          .json({ error: 'The reward network changed. Reload before requesting a payout.' });
      if (!verifyClaimAuthorization(input, origin, input.signature))
        return res
          .status(401)
          .json({ error: 'Sign a fresh reward request message with your wallet' });
      try {
        await assertWalletExecutionGate(connection, genesis);
      } catch {
        return res.status(503).json({
          error: 'Reward requests are disabled for this network. Your funded rewards remain saved.',
          requestAccepted: false,
        });
      }
      if (!takeLimit(`reward-request:${genesis}:${input.wallet}`, 12, 60_000))
        return res.status(429).json({
          error: 'Too many reward requests. Check the saved request before trying again.',
        });
      const coin = await registeredCoin(genesis, input.mint);
      if (!coin || !isWalletPolicy(coin.policy_version))
        return res.status(409).json({ error: 'This token has no funded wallet reward policy' });
      if (
        hasCreatorRewards(coin.mode) &&
        (input.epoch !== null || input.wallet !== coin.original_deployer)
      )
        return res
          .status(403)
          .json({ error: 'Only the original creator can request these rewards' });
      if (coin.mode === 'community' && input.epoch === null)
        return res.status(400).json({ error: 'Select a funded hourly reward' });
      try {
        await assertWalletRecipientCredit(
          connection,
          new PublicKey(input.wallet),
          BigInt(input.amount)
        );
      } catch (error) {
        if (error instanceof WalletRecipientUnavailable)
          return res.status(400).json({
            error: 'Accrue more rewards or fund your wallet before requesting this payout.',
            requestAccepted: false,
          });
        throw error;
      }
      if ((await networkGenesis(true)) !== genesis)
        return res
          .status(409)
          .json({ error: 'The reward network changed. Reload before requesting a payout.' });
      if (!verifyClaimAuthorization(input, origin, input.signature))
        return res.status(401).json({
          error: 'This reward authorization expired. Sign a fresh message.',
          requestAccepted: false,
        });
      reservationAttempted = true;
      const job = await store.requestClaim({
        networkGenesis: genesis,
        mint: input.mint,
        wallet: input.wallet,
        epoch: input.epoch === null ? null : Number(input.epoch),
        amount: BigInt(input.amount),
        requestId: input.requestId,
        authorizationDigest: createHash('sha256')
          .update(claimAuthorizationMessage(origin, input))
          .digest('hex'),
      });
      return res.status(job.status === 'finalized' ? 200 : 202).json(safeJob(job, input.requestId));
    }
    const checked = check.safeParse(req.body);
    if (checked.success) {
      const input = checked.data;
      if (input.networkGenesis !== genesis)
        return res
          .status(409)
          .json({ error: 'The reward network changed. Reload before checking this request.' });
      const job = await store.job(input.id);
      if (
        !job ||
        job.network_genesis !== genesis ||
        job.mint !== input.mint ||
        job.recipient !== input.wallet ||
        !['creator_claim', 'community_claim'].includes(job.kind)
      )
        return res.status(404).json({ error: 'Payout request not found' });
      // Status checks never construct, sign, submit or replace a transaction.
      if ((await networkGenesis(true)) !== genesis)
        throw new Error('Network changed during reward lookup');
      return res
        .status(job.status === 'finalized' || job.status === 'failed' ? 200 : 202)
        .json(safeJob(job));
    }
    return res.status(400).json({ error: 'Invalid reward request' });
  } catch {
    return res.status(503).json({
      error:
        'Rewards are temporarily unavailable. Existing payout requests remain saved; check again before requesting another.',
      ...(req.method === 'POST' && req.body?.action === 'prepare' && !reservationAttempted
        ? { requestAccepted: false }
        : {}),
    });
  }
}
