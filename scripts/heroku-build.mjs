import { spawnSync } from 'node:child_process';
import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateEnv, publicBuildEnvironment } from './validate-env.mjs';
import { buildWebEnvironmentValidator } from './build-web-env.mjs';

validateEnv();
const publicEnvironment = publicBuildEnvironment();
console.log(
  JSON.stringify({
    publicBuildNetwork: publicEnvironment.NEXT_PUBLIC_NETWORK,
    publicBuildPool: publicEnvironment.NEXT_PUBLIC_POOL_CONFIG_KEY,
  })
);
const result = spawnSync('pnpm', ['--filter', '@meteora-invent/scaffold/fun-launch', 'build'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
if (process.platform === 'win32') {
  console.log('Windows build verified. Standalone packaging runs on the Heroku Linux builder.');
  process.exit(0);
}
const app = 'scaffolds/fun-launch';
const output = `${app}/.next/standalone/${app}`;
await mkdir(`${output}/.next`, { recursive: true });
await cp(`${app}/.next/static`, `${output}/.next/static`, { recursive: true });
await cp(`${app}/public`, `${output}/public`, { recursive: true });

// Next may trace local env files. Runtime configuration must come from Heroku config vars.
async function removeEnvFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isFile() && /^\.env(?:\.|$)/.test(entry.name)) await rm(file);
    else if (entry.isDirectory()) await removeEnvFiles(file);
  }
}
await removeEnvFiles(`${app}/.next/standalone`);
await buildWebEnvironmentValidator();
await writeFile(
  `${app}/.next/standalone/scripts/public-build-environment.json`,
  JSON.stringify(publicEnvironment, null, 2) + '\n'
);
