// Operator process for daily XMR payouts. Runs beside monero-wallet-rpc; never in the web app.
//   node masked-payouts.cjs once   one pass now, planning a batch if one is due
//   node masked-payouts.cjs loop   a pass every minute
import { connection, networkGenesis } from '../dbc';
import { moneroWalletFromEnv } from './moneroWallet';
import { DEFAULT_FEE_BPS, MaskedXmrPayouts } from './maskedXmrPayouts';
import { moneroSealConfigured } from './moneroSeal';
import { priceSourceFromEnv } from './xmrPrice';

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
  const pass = async () => {
    const result = await payouts.runOnce(await payouts.due(new Date(), hour));
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
