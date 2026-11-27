// Operator process for daily XMR payouts. Runs beside monero-wallet-rpc; never in the web app.
//   node masked-payouts.cjs once   one pass now, planning a batch if one is due
//   node masked-payouts.cjs loop   a pass every minute
import { connection, networkGenesis } from '../dbc';
import { moneroWalletFromEnv } from './moneroWallet';
import { DEFAULT_FEE_BPS, MaskedXmrPayouts } from './maskedXmrPayouts';
import { moneroSealConfigured } from './moneroSeal';
import { priceSourceFromEnv } from './xmrPrice';
import { MaskedTreasuryProof } from './maskedTreasuryProof';
import { NETWORK_GENESIS } from '../launchConfig';

/** Passes between treasury proof updates (one pass a minute). */
const PROOF_EVERY_PASSES = 60;

async function main(mode: string) {
  const wallet = moneroWalletFromEnv();
  if (!wallet) throw new Error('MONERO_WALLET_RPC_URL is required');
  if (!moneroSealConfigured()) throw new Error('MONERO_ADDRESS_KEY is required');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const feeBps = Number(process.env.MASKED_XMR_FEE_BPS ?? DEFAULT_FEE_BPS);
  const hour = Number(process.env.MASKED_XMR_PAYOUT_HOUR_UTC ?? 12);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error('Invalid payout hour');
  const genesis = await networkGenesis(true);
  if ((await connection.getGenesisHash()) !== genesis) throw new Error('RPC network changed');
  const payouts = new MaskedXmrPayouts(wallet, priceSourceFromEnv(), genesis, {
    feeBps,
    alert: (alert) => console.error(JSON.stringify({ event: 'xmr_payout_alert', ...alert })),
  });
  const restore = process.env.MASKED_TREASURY_RESTORE_HEIGHT;
  if (restore !== undefined && !/^\d{1,9}$/.test(restore))
    throw new Error('Invalid MASKED_TREASURY_RESTORE_HEIGHT');
  const proof = new MaskedTreasuryProof(
    wallet,
    genesis,
    genesis === NETWORK_GENESIS['mainnet-beta'] ? 'mainnet' : 'stagenet',
    { restoreHeight: restore === undefined ? undefined : Number(restore) }
  );
  let passes = 0;
  const pass = async () => {
    const result = await payouts.runOnce(await payouts.due(new Date(), hour));
    // Publish the treasury's audit data hourly, and right after a batch settles.
    if (passes++ % PROOF_EVERY_PASSES === 0 || result.status === 'paid') {
      // A proof failure never holds up payouts; it is retried on the next proof pass.
      await proof
        .publish(await wallet.height())
        .then((published) =>
          console.info(JSON.stringify({ event: 'xmr_treasury_proof', ...published }))
        )
        .catch((error: unknown) =>
          console.error(
            JSON.stringify({
              event: 'xmr_payout_alert',
              level: 'warning',
              message: `Treasury proof not published: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown'}`,
            })
          )
        );
    }
    console.info(
      JSON.stringify({ event: 'xmr_payout_pass', ...result }, (_, v) =>
        typeof v === 'bigint' ? v.toString() : v
      )
    );
  };
  if (mode === 'once') return pass();
  if (mode !== 'loop') throw new Error('Use "once" or "loop"');
  for (;;) {
    await pass().catch((error: unknown) =>
      console.error(
        JSON.stringify({
          event: 'xmr_payout_alert',
          level: 'critical',
          message: error instanceof Error ? error.message.slice(0, 300) : 'unknown error',
        })
      )
    );
    await new Promise((resolve) => setTimeout(resolve, 60_000));
  }
}

main(process.argv[2] ?? 'once').catch((error: unknown) => {
  console.error(
    JSON.stringify({
      code: 'XMR_PAYOUTS_FAILED',
      message: error instanceof Error ? error.message.slice(0, 300) : 'unknown error',
    })
  );
  process.exitCode = 1;
});
