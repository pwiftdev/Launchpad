import type { NextApiRequest, NextApiResponse } from 'next';
import { apiGuard } from '@/server/apiGuard';
import { getConfig, networkGenesis } from '@/server/dbc';
import { verifiedTradingAccess } from '@/server/tradingAccess';
import { NETWORK_GENESIS } from '@/server/launchConfig';
import bondPolicy from '@/constants/bondPolicy.json';
import { SCHEDULE, SPLIT, feeMode, isFeeModeId } from '@/lib/feeModes';

/** Operator preview state and real configured costs; never an activation switch. */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!apiGuard(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const requested = req.query.mode;
  const bond = requested === undefined || requested === 'bond';
  if (!bond && !isFeeModeId(requested))
    return res.status(400).json({ error: 'Invalid launch mode' });
  try {
    const genesis = await networkGenesis();
    const network =
      genesis === NETWORK_GENESIS['mainnet-beta']
        ? 'mainnet-beta'
        : genesis === NETWORK_GENESIS.devnet
          ? 'devnet'
          : 'localnet';
    const common = {
      network,
      genesis,

    };

    if (!bond && isFeeModeId(requested)) {
      const approved = await verifiedTradingAccess(requested).catch((): null => null);
      const mode = feeMode(requested);
      return res.status(200).json({
        ...common,
        canLaunch: !!approved && approved.genesis === genesis,
        configKey: approved?.key.toBase58(),
        poolCreationFeeSol: approved ? Number(approved.config.poolCreationFee.toString()) / 1e9 : 0,
        tokenDecimals: approved?.config.tokenDecimal,
        policyVersion: mode.policyVersion,
        mode: mode.id,
        quote: mode.quoteSymbol,
        tradingFees: {
          launchSlotBps: SCHEDULE.startingFeeBps,
          beforeBondingBps: SCHEDULE.endingFeeBps,
          afterBondingBps: SCHEDULE.migrationFeeBps,
          protectionSlots: SCHEDULE.periodSlots,
          creatorBundledBuyExempt: true,
        },
        split: SPLIT,
        mainnetTradingEnabled: false,
        ...(approved ? {} : { notice: `${mode.label} requires a reviewed, enabled launch configuration.` }),
      });
    }

    const config = await getConfig();
    let canPrepare = false,
      policyVersion = 'unreviewed';
    try {
      const approved = await verifiedTradingAccess('bond');
      canPrepare = true;
      policyVersion = approved.record?.policy_version ?? 'legacy-devnet';
    } catch {
      /* Configuration remains discoverable while new launches fail closed. */
    }
    return res.status(200).json({
      ...common,
      canLaunch: canPrepare,
      poolCreationFeeSol: Number(config.poolCreationFee.toString()) / 1e9,
      tokenDecimals: config.tokenDecimal,
      policyVersion,
      mode: 'bond',
      tradingFees: {
        launchSlotBps: bondPolicy.startingFeeBps,
        beforeBondingBps: bondPolicy.endingFeeBps,
        afterBondingBps: bondPolicy.migrationFeeBps,
        protectionSlots: bondPolicy.periodSlots,
        creatorBundledBuyExempt: true,
      },
      mainnetTradingEnabled: canPrepare && network === 'mainnet-beta',
      ...(canPrepare
        ? {}
        : {
            notice: 'New launches require a reviewed configuration and the company fee wallets.',
          }),
    });
  } catch {
    return res
      .status(503)
      .json({ canLaunch: false, error: 'Launch configuration is temporarily unavailable' });
  }
}
