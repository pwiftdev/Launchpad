import { runFinancialScheduler } from './schedulerCli';
runFinancialScheduler().catch(() => {
  console.error(
    JSON.stringify({
      code: 'UNSIGNED_SCHEDULER_FAILED',
      message:
        'Scheduler stopped. Check the pinned network, database migration, checkpoint signing configuration and reviewed public operator settings privately.',
    })
  );
  process.exitCode = 1;
});
