const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyRustAdvisories, hash } = require('./rust-advisory-core.cjs');
const now = Date.parse('2026-10-28T12:00:00Z');
function fixture() {
  const pk = (name, version, kind = 'lib') => ({
      id: name,
      name,
      version,
      targets: [{ kind: [kind] }],
    }),
    packages = [
      pk('rinsed-vault', '0.1.0'),
      pk('bincode', '1.3.3'),
      pk('h2', '0.3.27'),
      pk('macro', '1.0.0', 'proc-macro'),
    ],
    edge = (pkg, kind) => ({ pkg, dep_kinds: [{ kind }] }),
    metadata = {
      version: 1,
      packages,
      resolve: {
        root: 'rinsed-vault',
        nodes: packages.map((p) => ({
          id: p.id,
          deps:
            p.name === 'rinsed-vault'
              ? [edge('bincode', null), edge('h2', 'dev'), edge('macro', null)]
              : [],
        })),
      },
    },
    files = {
      'metadata.json': JSON.stringify(metadata),
      'runtime-tree.txt': 'rinsed-vault v0.1.0\nbincode v1.3.3\n',
      'build-tree.txt': 'rinsed-vault v0.1.0\nbincode v1.3.3\nmacro v1.0.0\n',
      'native-tree.txt': '0rinsed-vault v0.1.0\n1bincode v1.3.3\n1h2 v0.3.27\n1macro v1.0.0\n',
      'toolchain.txt': 'rustc 1.89.0-dev\ntarget_arch="sbf"\ntarget_os="solana"\n',
    },
    lock = packages
      .map((p) => `[[package]]\nname = "${p.name}"\nversion = "${p.version}"\n`)
      .join('\n'),
    cargoToml = '[package]\nname="rinsed-vault"\n',
    manifest = {
      version: 1,
      target: 'sbpf-solana-solana',
      rootPackage: 'rinsed-vault',
      lockSha256: hash(lock),
      cargoTomlSha256: hash(cargoToml),
      files: Object.fromEntries(Object.entries(files).map(([name, value]) => [name, hash(value)])),
    },
    finding = (id, name, version) => ({
      package: { name, version },
      advisory: { id, title: 'Public advisory' },
    }),
    audit = {
      database: { 'last-commit': 'a'.repeat(40), 'last-updated': '2026-10-28T10:00:00Z' },
      lockfile: { 'dependency-count': 4 },
      settings: {
        ignore: [],
        severity: null,
        target_arch: [],
        target_os: [],
        informational_warnings: ['unmaintained', 'unsound', 'notice'],
      },
      vulnerabilities: {
        found: true,
        count: 1,
        list: [finding('RUSTSEC-2026-0258', 'h2', '0.3.27')],
      },
      warnings: { unmaintained: [finding('RUSTSEC-2025-0141', 'bincode', '1.3.3')] },
    },
    policy = {
      version: 1,
      lockSha256: hash(lock),
      recheckBefore: '2026-11-27T00:00:00Z',
      classifications: [
        {
          id: 'RUSTSEC-2026-0258',
          package: 'h2',
          version: '0.3.27',
          kind: 'vulnerability',
          scope: 'native-test',
          reason: 'Only isolated native tests; no production signer or deployed SBF dependency.',
        },
        {
          id: 'RUSTSEC-2025-0141',
          package: 'bincode',
          version: '1.3.3',
          kind: 'unmaintained',
          scope: 'sbf-runtime',
          reason:
            'Unmaintained upstream serialization dependency; maintenance remains a review requirement.',
        },
      ],
    };
  return { manifest, files, lock, cargoToml, audit, policy, now };
}
function changeMetadata(input, change) {
  const metadata = JSON.parse(input.files['metadata.json']);
  change(metadata);
  input.files['metadata.json'] = JSON.stringify(metadata);
  input.manifest.files['metadata.json'] = hash(input.files['metadata.json']);
}
test('retains native test vulnerabilities and runtime maintenance without calling either fixed', () => {
  const result = classifyRustAdvisories(fixture());
  assert.equal(result.passed, true);
  assert.equal(result.runtimeVulnerabilities, 0);
  assert.equal(result.runtimeMaintenance, 1);
  assert.equal(result.remainingNonRuntimeVulnerabilities, 1);
  assert.equal(result.findings.length, 2);
});
test('a dev-only exception can never waive a newly normal runtime vulnerability, even when policy is relabeled', () => {
  const input = fixture();
  changeMetadata(input, (m) => {
    m.resolve.nodes[0].deps.find((d) => d.pkg === 'h2').dep_kinds[0].kind = null;
  });
  input.policy.classifications[0].scope = 'sbf-runtime';
  const result = classifyRustAdvisories(input);
  assert.equal(result.passed, false);
  assert.ok(result.violations.some((v) => v.reason === 'runtime-vulnerability-or-unsoundness'));
});
test('procedural macros are host build scope and new advisory IDs still stop the guard', () => {
  const input = fixture();
  input.audit.warnings.unsound = [
    { package: { name: 'macro', version: '1.0.0' }, advisory: { id: 'RUSTSEC-2026-9999' } },
  ];
  const result = classifyRustAdvisories(input);
  assert.equal(result.passed, false);
  assert.equal(result.findings.find((x) => x.package === 'macro').scope, 'sbf-build');
});
test('independent tree/metadata disagreement and tampered evidence are rejected', () => {
  const input = fixture();
  input.files['runtime-tree.txt'] += 'h2 v0.3.27\n';
  input.manifest.files['runtime-tree.txt'] = hash(input.files['runtime-tree.txt']);
  assert.throws(() => classifyRustAdvisories(input), /Independent runtime graph/);
  const tampered = fixture();
  tampered.files['metadata.json'] += ' ';
  assert.throws(() => classifyRustAdvisories(tampered), /digest mismatch/);
});
test('changed lockfiles, stale classifications and wrong targets cannot reuse an exclusion', () => {
  const input = fixture();
  input.lock += '\n';
  assert.throws(() => classifyRustAdvisories(input), /locked SBF inputs/);
  const expired = fixture();
  expired.now = Date.parse('2026-11-27T00:00:00Z');
  assert.throws(() => classifyRustAdvisories(expired), /classification expired/);
  const wrong = fixture();
  wrong.manifest.target = 'x86_64-unknown-linux-gnu';
  assert.throws(() => classifyRustAdvisories(wrong), /locked SBF inputs/);
});
test('ignored/filtered/stale/incomplete RustSec reports fail closed', () => {
  for (const change of [
    (x) => {
      x.audit.settings.ignore = ['RUSTSEC-2026-0258'];
    },
    (x) => {
      x.audit.settings.informational_warnings = ['unmaintained'];
    },
    (x) => {
      x.audit.database['last-updated'] = '2026-01-01T00:00:00Z';
    },
    (x) => {
      x.audit.lockfile['dependency-count'] = 3;
    },
    (x) => {
      x.audit.vulnerabilities.count = 0;
    },
  ]) {
    const input = fixture();
    change(input);
    assert.throws(() => classifyRustAdvisories(input));
  }
});
test('a dropped previously reviewed warning cannot pass using otherwise consistent report counts', () => {
  const input = fixture();
  input.audit.warnings.unmaintained = [];
  const result = classifyRustAdvisories(input);
  assert.equal(result.passed, false);
  assert.ok(
    result.violations.some(
      (value) =>
        value.id === 'RUSTSEC-2025-0141' && value.reason === 'previously-reviewed-finding-missing'
    )
  );
});
