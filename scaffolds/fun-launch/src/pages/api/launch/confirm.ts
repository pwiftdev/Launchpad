import type { NextApiRequest, NextApiResponse } from 'next';
import { PublicKey } from '@solana/web3.js';
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { paysThroughCollector, usesLaunchSlot } from '@/lib/launchModes';
import { z } from 'zod';
import { apiGuard } from '@/server/apiGuard';
import { connection, networkGenesis, getConfig, invalidateCoinDiscovery } from '@/server/dbc';
import { launchIntent, registeredCoin, recordFinalizedLaunch } from '@/server/launchRegistry';
import { touchDisplayIndex } from '@/server/display';
import {
  configuredVaultProgram,
  verifyConfigAccount,
  verifyLaunchConfig,
} from '@/server/launchConfig';
import { proveLaunchCreation } from '@/server/launchProof';
import { vaultAddresses } from '@/lib/vault/client';
import { decodeVaultCoin } from '@/lib/vault/state';

export const config = { api: { bodyParser: { sizeLimit: '2kb' } } };
const input = z
  .object({
    mint: z.string().min(32).max(44),
    signature: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/),
    genesis: z.string().min(32).max(44).optional(),
  })
  .strict();

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!apiGuard(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const parsed = input.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid launch confirmation' });
  try {
    const mint = new PublicKey(parsed.data.mint),
      genesis = await networkGenesis(true);
    if (parsed.data.genesis !== undefined && parsed.data.genesis !== genesis)
      return res.status(409).json({ error: 'This saved launch belongs to another network' });
    const existing = await registeredCoin(genesis, mint.toBase58());
    if (existing) {
      if (existing.creation_signature !== parsed.data.signature)
        return res
          .status(409)
          .json({ error: 'Launch is already registered with another creation transaction' });
      return res.status(200).json({
        status: 'registered',
        genesis,
        mint: existing.mint,
        mode: existing.mode,
        originalDeployer: existing.original_deployer,
      });
    }
    const intent = await launchIntent(genesis, mint.toBase58());
    if (!intent)
      return res.status(404).json({ error: 'No signed launch intent exists for this mint' });
    const tx = await connection.getTransaction(parsed.data.signature, {
      commitment: 'finalized',
      maxSupportedTransactionVersion: 0,
    });
    if (!tx) return res.status(202).json({ status: 'pending', retryAfterMs: 2000 });
    const finalizedClient = new DynamicBondingCurveClient(connection, 'finalized');
    const pool = await finalizedClient.state.getPoolByBaseMint(mint);
    if (!pool) return res.status(202).json({ status: 'pending', retryAfterMs: 2000 });
    const state = pool.account.poolState;
    if (state.config.toBase58() !== intent.config_key)
      throw new Error('Pool config differs from its signed intent');
    const key = new PublicKey(intent.config_key),
      config = await getConfig(key, true);
    const digest = await verifyConfigAccount(connection, key);
    const reviewed = await verifyLaunchConfig(genesis, key, config, digest, intent.mode, {
      allowDisabled: true,
      allowLegacy: true,
    });
    if (!reviewed) throw new Error('New-mode launches require a reviewed policy');
    const proof = proveLaunchCreation(tx, {
      mint: mint.toBase58(),
      config: intent.config_key,
      pool: pool.publicKey.toBase58(),
      deployer: intent.deployer,
      intentCreatedAt: new Date(intent.created_at).getTime(),
      intentExpiresAt: new Date(intent.expires_at).getTime(),
      preparedSlot: intent.prepared_slot,
      policyVersion: reviewed.policy_version,
      ...(reviewed.policy_version === 'rinse-v1' ? { vaultProgram: configuredVaultProgram() } : {}),
      mode: intent.mode,
    });
    if (!proof.signature || proof.signature !== parsed.data.signature)
      throw new Error('Creation signature mismatch');
    if (usesLaunchSlot(intent.mode) && (!Number.isSafeInteger(tx.blockTime) || tx.blockTime! <= 0))
      throw new Error('The finalized launch timestamp is required');
    if (reviewed.policy_version === 'rinse-v1') {
      const program = configuredVaultProgram();
      const custodyAccount = await connection.getAccountInfo(
        vaultAddresses(program, mint).coin,
        'finalized'
      );
      if (!custodyAccount?.owner.equals(program))
        throw new Error('Finalized custody registration is unavailable');
      const custody = decodeVaultCoin(custodyAccount.data);
      if (
        custody.mode !== intent.mode ||
        custody.creator.toBase58() !== intent.deployer ||
        !custody.mint.equals(mint) ||
        !custody.pool.equals(pool.publicKey) ||
        !custody.config.equals(key) ||
        custody.configHash !== digest
      )
        throw new Error('Finalized custody identity differs from its signed intent');
    }
    if ((await networkGenesis(true)) !== genesis)
      return res.status(409).json({
        error:
          'Network changed while verifying this launch. Keep the saved receipt and retry confirmation.',
      });
    const saved = await recordFinalizedLaunch({
      network_genesis: genesis,
      mint: mint.toBase58(),
      dbc_pool: pool.publicKey.toBase58(),
      config_key: intent.config_key,
      original_deployer: intent.deployer,
      mode: intent.mode,
      recipient: paysThroughCollector(intent.mode)
        ? reviewed.expected_fee_claimer
        : intent.deployer,
      policy_version: reviewed.policy_version,
      quote_mint: config.quoteMint.toBase58(),
      activation_point: state.activationPoint.toString(),
      activation_time: usesLaunchSlot(intent.mode) ? String(tx.blockTime) : null,
      creation_signature: parsed.data.signature,
      finalized_slot: String(proof.slot),
      creator_share_bps: intent.creator_share_bps ?? null,
    });
    invalidateCoinDiscovery(saved.mint);
    await touchDisplayIndex(saved.mint);
    return res.status(200).json({
      status: 'registered',
      genesis,
      mint: saved.mint,
      mode: saved.mode,
      originalDeployer: saved.original_deployer,
      creatorShareBps: saved.creator_share_bps ?? null,
    });
  } catch {
    return res.status(422).json({
      error:
        'The finalized launch could not be verified. Your token may already exist; retry confirmation without launching again.',
    });
  }
}
