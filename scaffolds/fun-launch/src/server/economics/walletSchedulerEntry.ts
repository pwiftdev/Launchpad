import { runWalletCli } from './walletCli';
runWalletCli(
  process.argv.includes('--help') ? ['--help'] : ['run', ...process.argv.slice(2)]
).catch(() => {
  console.error(
    JSON.stringify({
      code: 'WALLET_SCHEDULER_FAILED',
      message: 'Wallet scheduler stopped. Existing signed attempts and reservations were retained.',
    })
  );
  process.exitCode = 1;
});
