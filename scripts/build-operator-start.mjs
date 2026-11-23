import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const require = createRequire(new URL('../scaffolds/fun-launch/package.json', import.meta.url));
const { build } = require('esbuild');
const directory = new URL('../scaffolds/fun-launch/.worker/', import.meta.url);
await build({
  entryPoints: [fileURLToPath(new URL('./operator-start.cjs', import.meta.url))],
  outfile: fileURLToPath(new URL('operator-start.cjs', directory)),
  bundle: true,
  packages: 'bundle',
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['pg-native', 'bufferutil', 'utf-8-validate'],
  nodePaths: [fileURLToPath(new URL('../scaffolds/fun-launch/node_modules/', import.meta.url))],
  logLevel: 'warning',
});
const files = {};
for (const file of ['operator-start.cjs', 'ops.cjs', 'scheduler.cjs'])
  files[file] = createHash('sha256')
    .update(await readFile(new URL(file, directory)))
    .digest('hex');
await writeFile(
  new URL('private-package-manifest.json', directory),
  JSON.stringify(
    {
      version: 2,
      policy: 'wallet-v1',
      nodeMajor: 24,
      pnpm: '10.27.0',
      unsignedSchedulerOnly: true,
      containsSigner: false,
      files,
    },
    null,
    2
  ) + '\n'
);
console.log(JSON.stringify({ privateOperatorPackageBuilt: true, containsSigner: false, files }));
