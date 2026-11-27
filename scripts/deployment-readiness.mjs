import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { validateEnv } from './validate-env.mjs';
import { companyWallets } from './company-wallets.cjs';
import { mainnetConfigPin, mainnetLaunchPolicy, NETWORK_GENESIS } from './network-policy.cjs';

/** Offline configuration checks only. Values and provider errors never enter the report. */
export function deploymentReadiness(env) {
  const checks = [];
  const check = (name, passed) => checks.push({ name, passed: Boolean(passed) });
  let valid = false;
  try {
    validateEnv(env);
    valid = true;
  } catch {
    /* fixed public status only */
  }
  check('baseEnvironment', valid);
  let currentWallets = false;
  try {
    companyWallets(env, NETWORK_GENESIS['mainnet-beta']);
    currentWallets = true;
  } catch {
    /* fixed public status only */
  }
  check('activeCollectorMatchesOwnerRecord', currentWallets);
  check('mainnetNetwork', env.NEXT_PUBLIC_NETWORK === 'mainnet-beta');
  const policy = mainnetLaunchPolicy(env);
  const masked =
    env.NEXT_PUBLIC_SITE_URL === 'https://mskd.fun' || Boolean(env.MAINNET_MASKED_CONFIG_KEY);
  check('mainnetLaunchPolicy', env.LAUNCH_POLICY_VERSION === policy);
  check(
    'canonicalDeploymentOrigin',
    env.NEXT_PUBLIC_SITE_URL === 'https://rinsed-launchpad-1675f6b9bebf.herokuapp.com' ||
      (policy === 'bond-v1' && env.NEXT_PUBLIC_SITE_URL === 'https://plzzz.bond') ||
      (policy === 'dev-v1' && env.NEXT_PUBLIC_SITE_URL === 'https://mskd.fun')
  );
  if (masked) {
    const config = mainnetConfigPin('masked-v1', env);
    const previous = mainnetConfigPin('mskd-v1', env);
    check('maskedConfigPinned', config && config !== env.POOL_CONFIG_KEY && config !== previous);
    check('legacyMskdConfigPinned', previous && previous !== env.POOL_CONFIG_KEY);
    const pool = env.MSKD_PAYOUT_POOL ?? '';
    check(
      'wxmrPoolPinned',
      /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(pool) &&
        pool !== config &&
        pool !== previous &&
        pool !== env.POOL_CONFIG_KEY
    );
    check('wxmrClaimsEnabled', env.MASKED_WXMR_PAYOUTS_ENABLED === 'true');
  }
  check('databaseConfigured', /^postgres(?:ql)?:\/\//.test(env.DATABASE_URL ?? ''));
  check('collectorConfigured', Boolean(env.FEE_COLLECTOR_PUBLIC_KEY));
  check('treasuryConfigured', Boolean(env.TREASURY_PUBLIC_KEY));
  check(
    'publicPoolMatchesServer',
    Boolean(env.POOL_CONFIG_KEY) && env.NEXT_PUBLIC_POOL_CONFIG_KEY === env.POOL_CONFIG_KEY
  );
  check('samplesDisabled', env.NEXT_PUBLIC_DEMO_LAUNCHES === 'false');
  check(
    'webHasNoFinancialWorker',
    env.WALLET_WORKER_ENABLED !== 'true' && env.FINANCIAL_WORKER_ENABLED !== 'true'
  );
  check(
    'releaseFlagsExplicit',
    ['true', 'false'].includes(env.LAUNCHPAD_PUBLIC) &&
      ['true', 'false'].includes(env.MAINNET_TRADING_ENABLED)
  );
  return {
    version: 1,
    policy,
    offline: true,
    configurationChecksPassed: checks.every((item) => item.passed),
    activationEnabled: env.LAUNCHPAD_PUBLIC === 'true' && env.MAINNET_TRADING_ENABLED === 'true',
    checks,
    unverified: [
      'onChainConfigAndRegistry',
      'databaseTlsAndMigrations',
      'operatorAndSigner',
      'fundedAcceptance',
      'domainTlsAndDeployedBuild',
    ],
    transactionsSigned: 0,
    transactionsSent: 0,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--env-file')) throw Error();
    // Explicit file only; never discover or print private environment files automatically.
    const env = args.length ? parseEnv(readFileSync(args[1], 'utf8')) : process.env;
    const result = deploymentReadiness(env);
    console.log(JSON.stringify(result, null, 2));
    if (!result.configurationChecksPassed) process.exitCode = 2;
  } catch {
    console.error(
      'Deployment check failed to read its explicit configuration. Private details withheld.'
    );
    process.exitCode = 1;
  }
}
