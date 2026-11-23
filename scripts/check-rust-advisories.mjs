import fs from 'node:fs';
import path from 'node:path';
import core from './rust-advisory-core.cjs';
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index],
    value = process.argv[index + 1];
  if (
    !['--graph', '--audit', '--policy', '--manifest-path', '--out'].includes(key) ||
    !value ||
    args.has(key)
  )
    throw new Error('Invalid Rust advisory checker option');
  args.set(key, value);
}
try {
  const graph = path.resolve(args.get('--graph') ?? '.local/rust-dependency-graph'),
    root = path.dirname(
      path.resolve(args.get('--manifest-path') ?? 'programs/rinsed-vault/Cargo.toml')
    ),
    manifest = JSON.parse(fs.readFileSync(path.join(graph, 'manifest.json'), 'utf8')),
    files = Object.fromEntries(
      Object.keys(manifest.files ?? {}).map((name) => {
        if (
          ![
            'metadata.json',
            'runtime-tree.txt',
            'build-tree.txt',
            'native-tree.txt',
            'toolchain.txt',
          ].includes(name)
        )
          throw new Error('Unknown Rust evidence file');
        return [name, fs.readFileSync(path.join(graph, name), 'utf8')];
      })
    ),
    result = core.classifyRustAdvisories({
      manifest,
      files,
      lock: fs.readFileSync(path.join(root, 'Cargo.lock')),
      cargoToml: fs.readFileSync(path.join(root, 'Cargo.toml')),
      audit: JSON.parse(
        fs.readFileSync(args.get('--audit') ?? '.local/rust-dependency-audit.json', 'utf8')
      ),
      policy: JSON.parse(
        fs.readFileSync(args.get('--policy') ?? 'scripts/rust-advisory-policy.json', 'utf8')
      ),
    });
  if (args.has('--out'))
    fs.writeFileSync(args.get('--out'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
} catch {
  console.error(
    'Rust advisory graph validation failed. Recollect locked target evidence and review all unfiltered findings.'
  );
  process.exitCode = 1;
}
