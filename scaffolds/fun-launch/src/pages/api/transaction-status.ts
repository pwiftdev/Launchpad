import { apiGuard } from '@/server/apiGuard';
import type { NextApiRequest, NextApiResponse } from 'next';
import { connection, networkGenesis } from '@/server/dbc';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!apiGuard(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const signature = req.query.signature;
  if (typeof signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature)) {
    return res.status(400).json({ error: 'Invalid signature' });
  }
  res.setHeader('Cache-Control', 'no-store');
  const rawHeight = req.query.lastValidBlockHeight;
  const height =
    typeof rawHeight === 'string' && /^\d+$/.test(rawHeight) ? Number(rawHeight) : undefined;
  if (rawHeight !== undefined && (height === undefined || !Number.isSafeInteger(height)))
    return res.status(400).json({ error: 'Invalid transaction expiry height' });
  const rawSlot = req.query.preparedSlot;
  const preparedSlot =
    typeof rawSlot === 'string' && /^\d+$/.test(rawSlot) ? Number(rawSlot) : undefined;
  if (rawSlot !== undefined && (preparedSlot === undefined || !Number.isSafeInteger(preparedSlot)))
    return res.status(400).json({ error: 'Invalid receipt slot' });
  try {
    const [{ value }, currentHeight, firstAvailable, genesis] = await Promise.all([
      connection.getSignatureStatuses([signature], { searchTransactionHistory: true }),
      height === undefined ? Promise.resolve(null) : connection.getBlockHeight('finalized'),
      preparedSlot === undefined ? Promise.resolve(null) : connection.getFirstAvailableBlock(),
      networkGenesis(true),
    ]);
    if (req.query.genesis !== undefined && req.query.genesis !== genesis)
      return res.status(409).json({ error: 'The saved transaction belongs to another network' });
    const status = value[0];
    return res.status(200).json({
      failed: !!status?.err,
      found: !!status,
      expired:
        !status &&
        currentHeight !== null &&
        height !== undefined &&
        currentHeight > height &&
        (preparedSlot === undefined || (firstAvailable !== null && firstAvailable <= preparedSlot)),
      historyIncomplete:
        preparedSlot !== undefined && firstAvailable !== null && firstAvailable > preparedSlot,
      finalized: status?.confirmationStatus === 'finalized',
      confirmed:
        status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized',
    });
  } catch {
    return res.status(502).json({ error: 'Could not check transaction status' });
  }
}
