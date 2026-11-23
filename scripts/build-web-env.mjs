import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const app = createRequire(new URL('../scaffolds/fun-launch/package.json', import.meta.url));
export async function buildWebEnvironmentValidator(
  outfile = fileURLToPath(
    new URL('../scaffolds/fun-launch/.next/standalone/scripts/validate-env.cjs', import.meta.url)
  )
) {
  const { build } = app('esbuild');
  await mkdir(path.dirname(outfile), { recursive: true });
  await build({
    entryPoints: [fileURLToPath(new URL('./validate-env.mjs', import.meta.url))],
    outfile,
    bundle: true,
    packages: 'bundle',
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['bufferutil', 'utf-8-validate'],
    nodePaths: [fileURLToPath(new URL('../scaffolds/fun-launch/node_modules/', import.meta.url))],
    logLevel: 'warning',
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error('No arguments accepted');
  await buildWebEnvironmentValidator();
}
