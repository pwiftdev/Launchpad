import { runFinancialOps } from './opsCli';
import { DammProofCapacityError } from './dammProofCapacity';
runFinancialOps().catch((error: unknown) => {
  if (error instanceof DammProofCapacityError) {
    console.error(
      JSON.stringify({
        code: error.code,
        capacity: error.capacity,
        observed: error.observed,
        maximum: error.maximum,
        message: error.message,
      })
    );
    process.exitCode = 3;
    return;
  }
  console.error(
    'Financial operation failed. No private configuration was printed. Check the pinned network, durable plan, finalized receipts and private operator settings.'
  );
  if (
    process.env.NODE_ENV !== 'production' &&
    process.env.LOCAL_VALIDATOR_ENABLED === 'true' &&
    process.env.FINANCIAL_LOCAL_DIAGNOSTICS === 'true'
  ) {
    const url = new URL(process.env.RPC_URL ?? 'http://invalid');
    if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      const value = error as { name?: string; message?: string; logs?: string[] };
      let message = String(value.message ?? 'Operation failed');
      for (const secret of [
        process.env.DATABASE_URL,
        process.env.WHITELIST_SECRET,
        process.env.ADMIN_SESSION_SECRET,
        process.env.FINANCIAL_CHECKPOINT_HMAC_KEY,
        process.env.FINANCIAL_CHECKPOINT_VERIFY_KEYS_JSON,
      ].filter(Boolean))
        message = message.split(secret!).join('[private]');
      console.error(
        JSON.stringify({ name: value.name, message, programLogs: value.logs?.slice(-30) })
      );
    }
  }
  process.exitCode = 1;
});
