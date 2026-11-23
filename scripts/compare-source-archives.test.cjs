const { test } = require('node:test');
const assert = require('node:assert/strict');
const { gzipSync } = require('node:zlib');
const { archiveInventory, compareSourceArchives } = require('./compare-source-archives.cjs');
function archive(entries) {
  const blocks = [];
  for (const [name, value] of entries) {
    const content = Buffer.from(value),
      header = Buffer.alloc(512);
    header.write(name);
    header.write('0000644\0', 100);
    header.write(content.length.toString(8).padStart(11, '0') + '\0', 124);
    header[156] = 48;
    header.fill(32, 148, 156);
    header.write(
      [...header]
        .reduce((a, b) => a + b, 0)
        .toString(8)
        .padStart(6, '0') + '\0 ',
      148
    );
    blocks.push(header, content, Buffer.alloc((512 - (content.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
test('provenance lists exact approved documentation changes while binding both archives', () => {
  const result = compareSourceArchives(
    archive([
      ['src/app.ts', 'unchanged'],
      ['docs/runbook.md', 'old'],
    ]),
    archive([
      ['docs/runbook.md', 'new'],
      ['src/app.ts', 'unchanged'],
      ['README.md', 'new'],
    ])
  );
  assert.equal(result.passed, true);
  assert.deepEqual(
    result.changedPaths.map((row) => row.path),
    ['README.md', 'docs/runbook.md']
  );
  assert.notEqual(result.buildInputArchiveSha256, result.sourceArchiveSha256);
});
test('code, policy JSON and removed runtime files require a rebuild', () => {
  for (const target of ['src/app.ts', 'scripts/policy.json', 'docs/config.json']) {
    const result = compareSourceArchives(archive([[target, 'old']]), archive([[target, 'new']]));
    assert.equal(result.passed, false);
    assert.equal(result.changedPaths[0].approvedDocumentation, false);
  }
  assert.equal(compareSourceArchives(archive([['src/app.ts', 'old']]), archive([])).passed, false);
});
test('duplicate, traversal, truncated and checksum-corrupt tar data fail closed', () => {
  assert.throws(() =>
    archiveInventory(
      archive([
        ['src/app.ts', 'x'],
        ['src/app.ts', 'y'],
      ])
    )
  );
  assert.throws(() => archiveInventory(archive([['docs/../src/app.ts', 'x']])));
  const bytes = require('node:zlib').gunzipSync(archive([['src/app.ts', 'x']]));
  bytes[0] ^= 1;
  assert.throws(() => archiveInventory(gzipSync(bytes)));
  assert.throws(() => archiveInventory(gzipSync(Buffer.alloc(512))));
});
