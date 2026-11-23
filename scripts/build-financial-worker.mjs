import { createRequire } from 'node:module';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../scaffolds/fun-launch/package.json', import.meta.url));
const { build } = require('esbuild');
if (process.argv.slice(2).some((arg) => arg !== '--standalone') || process.argv.length > 3)
  throw new Error('Only the optional --standalone build flag is supported');
const standalone = process.argv[2] === '--standalone';
const directory = new URL('../scaffolds/fun-launch/.worker/', import.meta.url);
await mkdir(directory, { recursive: true });
const outputs = {
  'ops.cjs': 'walletEntry.ts',
  'scheduler.cjs': 'walletSchedulerEntry.ts',
  'wallet-signer.cjs': 'walletSignerEntry.ts',
};
const inputs = {};
for (const [output, entry] of Object.entries(outputs)) {
  const result = await build({
    entryPoints: [
      fileURLToPath(
        new URL(`../scaffolds/fun-launch/src/server/economics/${entry}`, import.meta.url)
      ),
    ],
    outfile: fileURLToPath(new URL(output, directory)),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    ...(standalone
      ? { packages: 'bundle', external: ['pg-native', 'bufferutil', 'utf-8-validate'] }
      : { packages: 'external' }),
    nodePaths: [fileURLToPath(new URL('../scaffolds/fun-launch/node_modules/', import.meta.url))],
    tsconfig: fileURLToPath(new URL('../scaffolds/fun-launch/tsconfig.json', import.meta.url)),
    metafile: true,
    logLevel: 'warning',
  });
  inputs[output] = Object.keys(result.metafile.inputs).sort();
}
// Only a stale generated legacy signer artifact is removed; reviewed archives stay intact.
await rm(new URL('signer.cjs', directory), { force: true });
await writeFile(
  new URL('build-inputs.json', directory),
  JSON.stringify(
    { version: 2, policy: 'wallet-v1', standalone, entries: outputs, inputs },
    null,
    2
  ) + '\n'
);
console.log(
  `${standalone ? 'Standalone' : 'Development'} wallet operator, unsigned scheduler and separate restricted wallet signer built. Automatic signing/relay remains explicitly gated.`
);
