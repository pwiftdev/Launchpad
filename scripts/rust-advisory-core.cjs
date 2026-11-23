'use strict';
const { createHash } = require('node:crypto');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const identity = (name, version) => `${name}@${version}`;
function treePackages(value) {
  if (typeof value !== 'string' || !value.trim())
    throw Error('Missing independent Rust dependency tree');
  const packages = new Set();
  for (const line of value.trim().split(/\r?\n/)) {
    const match = line.match(/^\d*([a-zA-Z0-9_-]+) v([^\s]+)(?:\s.*)?$/);
    if (!match) throw Error('Malformed Rust dependency tree');
    packages.add(identity(match[1], match[2]));
  }
  return packages;
}
function metadataRuntime(metadata) {
  if (
    metadata?.version !== 1 ||
    !Array.isArray(metadata.packages) ||
    !Array.isArray(metadata.resolve?.nodes) ||
    typeof metadata.resolve.root !== 'string'
  )
    throw Error('Incomplete Rust metadata');
  const packages = new Map(metadata.packages.map((value) => [value.id, value])),
    nodes = new Map(metadata.resolve.nodes.map((value) => [value.id, value])),
    seen = new Set(),
    paths = new Map();
  if (
    packages.size !== metadata.packages.length ||
    nodes.size !== metadata.resolve.nodes.length ||
    packages.get(metadata.resolve.root)?.name !== 'rinsed-vault'
  )
    throw Error('Wrong Rust metadata root');
  function visit(id, path = []) {
    const packageValue = packages.get(id),
      node = nodes.get(id);
    if (!packageValue || !node || !Array.isArray(packageValue.targets) || !Array.isArray(node.deps))
      throw Error('Missing resolved Rust package');
    if (seen.has(id) || packageValue.targets.some((target) => target.kind?.includes('proc-macro')))
      return;
    seen.add(id);
    const key = identity(packageValue.name, packageValue.version),
      current = [...path, key];
    paths.set(key, current);
    for (const dep of node.deps) {
      if (
        !Array.isArray(dep.dep_kinds) ||
        dep.dep_kinds.some((kind) => !['normal', 'dev', 'build', null].includes(kind.kind))
      )
        throw Error('Unknown Rust dependency kind');
      if (dep.dep_kinds.some((kind) => kind.kind === null || kind.kind === 'normal'))
        visit(dep.pkg, current);
    }
  }
  visit(metadata.resolve.root);
  return paths;
}
function classifyRustAdvisories({
  manifest,
  files,
  lock,
  cargoToml,
  audit,
  policy,
  now = Date.now(),
}) {
  if (
    manifest?.version !== 1 ||
    manifest.target !== 'sbpf-solana-solana' ||
    manifest.rootPackage !== 'rinsed-vault' ||
    manifest.lockSha256 !== hash(lock) ||
    manifest.cargoTomlSha256 !== hash(cargoToml)
  )
    throw Error('Rust graph is not bound to current locked SBF inputs');
  for (const name of [
    'metadata.json',
    'runtime-tree.txt',
    'build-tree.txt',
    'native-tree.txt',
    'toolchain.txt',
  ])
    if (typeof files?.[name] !== 'string' || manifest.files?.[name] !== hash(files[name]))
      throw Error('Rust graph evidence digest mismatch');
  if (
    !files['toolchain.txt'].includes('target_os="solana"') ||
    !files['toolchain.txt'].includes('target_arch="sbf"')
  )
    throw Error('Rust graph compiler did not target SBF');
  if (
    policy?.version !== 1 ||
    policy.lockSha256 !== hash(lock) ||
    !Array.isArray(policy.classifications) ||
    !Number.isFinite(Date.parse(policy.recheckBefore)) ||
    now >= Date.parse(policy.recheckBefore)
  )
    throw Error('Rust advisory classification expired or inputs changed');
  if (
    !audit?.database ||
    !/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(audit.database['last-commit']) ||
    !Number.isFinite(Date.parse(audit.database['last-updated'])) ||
    now - Date.parse(audit.database['last-updated']) > 7 * 24 * 3600000 ||
    Date.parse(audit.database['last-updated']) > now + 24 * 3600000 ||
    !Array.isArray(audit.vulnerabilities?.list) ||
    audit.vulnerabilities.count !== audit.vulnerabilities.list.length ||
    !audit.warnings ||
    !Array.isArray(audit.settings?.ignore) ||
    audit.settings.ignore.length ||
    audit.settings.severity !== null ||
    audit.settings.target_arch?.length ||
    audit.settings.target_os?.length
  )
    throw Error('Incomplete, filtered or stale RustSec report');
  const locked = new Set(
    String(lock)
      .split(/^\[\[package\]\]/m)
      .slice(1)
      .map((block) => {
        const name = block.match(/^name = "([^"\r\n]+)"$/m)?.[1],
          version = block.match(/^version = "([^"\r\n]+)"$/m)?.[1];
        if (!name || !version) throw Error('Malformed Cargo lock package');
        return identity(name, version);
      })
  );
  if (
    audit.lockfile?.['dependency-count'] !== String(lock).split(/^\[\[package\]\]/m).length - 1 ||
    audit.vulnerabilities.found !== audit.vulnerabilities.count > 0 ||
    !Array.isArray(audit.settings.target_arch) ||
    !Array.isArray(audit.settings.target_os)
  )
    throw Error('RustSec report does not describe this complete lockfile');
  for (const kind of ['unmaintained', 'unsound', 'notice'])
    if (!audit.settings.informational_warnings?.includes(kind))
      throw Error('RustSec informational findings were filtered');
  const paths = metadataRuntime(JSON.parse(files['metadata.json'])),
    tree = treePackages(files['runtime-tree.txt']),
    build = treePackages(files['build-tree.txt']),
    native = treePackages(files['native-tree.txt']);
  for (const key of tree)
    if (!paths.has(key))
      throw Error('Independent runtime graph disagrees with conservative metadata');
  for (const key of tree)
    if (!build.has(key)) throw Error('Independent build graph omits a runtime package');
  const all = [...audit.vulnerabilities.list.map((value) => ({ ...value, kind: 'vulnerability' }))];
  for (const [kind, values] of Object.entries(audit.warnings)) {
    if (!['unmaintained', 'unsound', 'notice'].includes(kind) || !Array.isArray(values))
      throw Error('Unknown RustSec warning type');
    all.push(...values.map((value) => ({ ...value, kind })));
  }
  const seen = new Set(),
    findings = [],
    violations = [];
  for (const value of all) {
    const name = value.package?.name,
      version = value.package?.version,
      id = value.advisory?.id,
      kind = value.kind;
    if (
      typeof name !== 'string' ||
      typeof version !== 'string' ||
      !/^RUSTSEC-\d{4}-\d{4}$/.test(id ?? '')
    )
      throw Error('Malformed RustSec finding');
    const key = identity(name, version),
      scope = paths.has(key)
        ? 'sbf-runtime'
        : build.has(key)
          ? 'sbf-build'
          : native.has(key)
            ? 'native-test'
            : 'other-target-lock',
      findingKey = `${kind}:${id}:${key}`;
    if (!locked.has(key))
      throw Error('RustSec finding package is absent from the current lockfile');
    if (seen.has(findingKey)) throw Error('Duplicate RustSec finding');
    seen.add(findingKey);
    const classified = policy.classifications.filter(
      (item) =>
        item.kind === kind &&
        item.id === id &&
        item.package === name &&
        item.version === version &&
        item.scope === scope
    );
    const allowed =
      classified.length === 1 &&
      typeof classified[0].reason === 'string' &&
      classified[0].reason.length >= 30;
    if (!allowed)
      violations.push({
        id,
        package: name,
        version,
        scope,
        reason: 'unreviewed-or-changed-classification',
      });
    if (scope === 'sbf-runtime' && ['vulnerability', 'unsound'].includes(kind))
      violations.push({
        id,
        package: name,
        version,
        scope,
        reason: 'runtime-vulnerability-or-unsoundness',
      });
    findings.push({
      id,
      kind,
      package: name,
      version,
      scope,
      path: paths.get(key) ?? null,
      title: value.advisory.title ?? null,
    });
  }
  for (const classified of policy.classifications) {
    const key = `${classified.kind}:${classified.id}:${identity(classified.package, classified.version)}`;
    if (!seen.has(key))
      violations.push({
        id: classified.id,
        package: classified.package,
        version: classified.version,
        scope: classified.scope,
        reason: 'previously-reviewed-finding-missing',
      });
  }
  return {
    passed: violations.length === 0,
    target: manifest.target,
    lockSha256: manifest.lockSha256,
    databaseCommit: audit.database['last-commit'],
    conservativeRuntimePackages: paths.size,
    independentRuntimePackages: tree.size,
    runtimeVulnerabilities: findings.filter(
      (x) => x.scope === 'sbf-runtime' && x.kind === 'vulnerability'
    ).length,
    runtimeUnsound: findings.filter((x) => x.scope === 'sbf-runtime' && x.kind === 'unsound')
      .length,
    runtimeMaintenance: findings.filter(
      (x) => x.scope === 'sbf-runtime' && x.kind === 'unmaintained'
    ).length,
    remainingNonRuntimeVulnerabilities: findings.filter(
      (x) => x.scope !== 'sbf-runtime' && x.kind === 'vulnerability'
    ).length,
    remainingNonRuntimeUnsound: findings.filter(
      (x) => x.scope !== 'sbf-runtime' && x.kind === 'unsound'
    ).length,
    findings,
    violations,
  };
}
module.exports = { classifyRustAdvisories, metadataRuntime, treePackages, hash };
