import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index],
    value = process.argv[index + 1];
  if (!['--cargo', '--rustc', '--manifest-path', '--out'].includes(key) || !value || args.has(key))
    throw new Error('Invalid Rust graph collector option');
  args.set(key, value);
}
const manifest = path.resolve(args.get('--manifest-path') ?? 'programs/rinsed-vault/Cargo.toml'),
  root = path.dirname(manifest),
  cargo = args.get('--cargo'),
  rustc = args.get('--rustc'),
  out = path.resolve(args.get('--out') ?? '.local/rust-dependency-graph'),
  target = 'sbpf-solana-solana';
if (!cargo || !rustc) throw new Error('Explicit pinned SBF cargo and rustc paths are required');
const hash = (value) => createHash('sha256').update(value).digest('hex'),
  lock = fs.readFileSync(path.join(root, 'Cargo.lock')),
  toml = fs.readFileSync(manifest);
function run(binary, args) {
  const result = spawnSync(binary, args, {
    cwd: root,
    env: { ...process.env, RUSTC: rustc },
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120000,
  });
  if (result.error || result.status !== 0)
    throw new Error('Locked offline Rust graph command failed');
  return result.stdout;
}
const cfg = run(rustc, ['--print', 'cfg', '--target', target]);
if (
  !cfg.split(/\r?\n/).includes('target_os="solana"') ||
  !cfg.split(/\r?\n/).includes('target_arch="sbf"')
)
  throw new Error('Unexpected Rust compiler target');
const files = {
  'metadata.json': run(cargo, [
    'metadata',
    '--offline',
    '--locked',
    '--format-version',
    '1',
    '--filter-platform',
    target,
  ]),
  'runtime-tree.txt': run(cargo, [
    'tree',
    '--offline',
    '--locked',
    '--target',
    target,
    '--edges',
    'normal,no-proc-macro',
    '--prefix',
    'none',
    '--format',
    '{p}',
  ]),
  'build-tree.txt': run(cargo, [
    'tree',
    '--offline',
    '--locked',
    '--target',
    target,
    '--edges',
    'normal,build',
    '--prefix',
    'none',
    '--format',
    '{p}',
  ]),
  'native-tree.txt': run(cargo, [
    'tree',
    '--offline',
    '--locked',
    '--target',
    'x86_64-unknown-linux-gnu',
    '--edges',
    'normal,build,dev',
    '--prefix',
    'depth',
    '--format',
    '{p}',
  ]),
  'toolchain.txt': run(rustc, ['--version', '--verbose']) + cfg,
};
if (
  hash(fs.readFileSync(path.join(root, 'Cargo.lock'))) !== hash(lock) ||
  hash(fs.readFileSync(manifest)) !== hash(toml)
)
  throw new Error('Rust input changed during graph collection');
fs.mkdirSync(out, { recursive: true });
for (const [name, value] of Object.entries(files)) fs.writeFileSync(path.join(out, name), value);
fs.writeFileSync(
  path.join(out, 'manifest.json'),
  JSON.stringify(
    {
      version: 1,
      target,
      rootPackage: 'rinsed-vault',
      lockSha256: hash(lock),
      cargoTomlSha256: hash(toml),
      files: Object.fromEntries(Object.entries(files).map(([name, value]) => [name, hash(value)])),
    },
    null,
    2
  ) + '\n'
);
console.log(
  JSON.stringify({ collected: true, target, offline: true, locked: true, lockSha256: hash(lock) })
);
