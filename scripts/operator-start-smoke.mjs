import { mkdtemp, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const execute = promisify(execFile),
  artifact = new URL('../scaffolds/fun-launch/.worker/', import.meta.url);
const folder = await mkdtemp(path.join(tmpdir(), 'rinsed-private-start-smoke-'));
try {
  const manifest = JSON.parse(
    await readFile(new URL('private-package-manifest.json', artifact), 'utf8')
  );
  for (const file of [
    'ops.cjs',
    'scheduler.cjs',
    'operator-start.cjs',
    'runtime-manifest.json',
    'private-package-manifest.json',
  ]) {
    const bytes = await readFile(new URL(file, artifact));
    if (file.endsWith('.cjs'))
      assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.files[file]);
    await copyFile(new URL(file, artifact), path.join(folder, file));
  }
  const options = {
    cwd: folder,
    env: {
      PATH: path.dirname(process.execPath),
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      NODE_ENV: 'production',
      NODE_OPTIONS: '',
      NODE_PATH: '',
    },
    timeout: 15000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  };
  const help = await execute(
    process.execPath,
    ['--no-global-search-paths', path.join(folder, 'operator-start.cjs'), '--help'],
    options
  );
  assert.match(help.stdout, /Private unsigned wallet scheduler:/);
  await assert.rejects(
    execute(
      process.execPath,
      ['--no-global-search-paths', path.join(folder, 'operator-start.cjs')],
      options
    ),
    (error) => {
      assert.match(error.stderr, /OPERATOR_CONFIG_ARGUMENT/);
      return true;
    }
  );
  Object.assign(manifest, {
    startupOutsideCheckoutHelpPassed: true,
    missingConfigFailsClosed: true,
    globalModuleSearchDisabled: true,
    containsSigner: false,
  });
  await writeFile(
    new URL('private-package-manifest.json', artifact),
    JSON.stringify(manifest, null, 2) + '\n'
  );
  console.log(
    JSON.stringify({
      privateStartupPortable: true,
      globalModuleSearchDisabled: true,
      missingConfigFailsClosed: true,
      signerCopied: false,
      files: manifest.files,
    })
  );
} finally {
  if (
    path.dirname(folder) !== path.resolve(tmpdir()) ||
    !path.basename(folder).startsWith('rinsed-private-start-smoke-')
  )
    throw new Error('Unsafe smoke fixture cleanup');
  await rm(folder, { recursive: true, force: true });
}
