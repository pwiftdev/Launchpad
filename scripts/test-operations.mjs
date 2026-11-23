import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The standalone smoke has its own Linux artifact job. All other operator regressions run here.
const directory = new URL('./', import.meta.url);
const files = (await readdir(directory))
  .filter((name) => /\.test\.(?:cjs|mjs)$/.test(name) && name !== 'standalone-smoke.test.mjs')
  .sort()
  .map((name) => fileURLToPath(new URL(name, directory)));
if (!files.length) throw new Error('No operational tests were discovered');
const child = spawn(process.execPath, ['--test', ...files], { stdio: 'inherit' });
child.on('error', () => {
  process.exitCode = 1;
});
child.on('close', (code) => {
  process.exitCode = code ?? 1;
});
