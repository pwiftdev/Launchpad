import { runWalletCli } from './walletCli';
runWalletCli().catch(() => {
  console.error(
    JSON.stringify({
      code: 'WALLET_OPERATION_FAILED',
      message:
        'Wallet operation stopped. Check reviewed network, database, wallet identity, reservations and external signer privately.',
    })
  );
  process.exitCode = 1;
});
