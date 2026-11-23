/* File-content provenance only; emits hashes and paths, never file contents. */
const fs = require('node:fs');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const field = (bytes) => bytes.toString('utf8').replace(/\0.*$/s, '');
function octal(bytes) {
  const value = field(bytes).trim();
  if (!/^[0-7]+$/.test(value)) throw Error('Unsupported tar numeric field');
  return Number.parseInt(value, 8);
}
function archiveInventory(archive) {
  const bytes = zlib.gunzipSync(archive, { maxOutputLength: 512 * 1024 * 1024 });
  const files = new Map();
  let offset = 0,
    pendingPath = null,
    pendingSize = null,
    ended = false;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) {
      if (
        pendingPath ||
        pendingSize !== null ||
        offset + 1024 > bytes.length ||
        !bytes.subarray(offset).every((value) => value === 0)
      )
        throw Error('Truncated or hidden trailing tar content');
      ended = true;
      break;
    }
    const checksum = [...header].reduce(
      (sum, value, index) => sum + (index >= 148 && index < 156 ? 32 : value),
      0
    );
    if (checksum !== octal(header.subarray(148, 156))) throw Error('Tar header checksum mismatch');
    const size = octal(header.subarray(124, 136)),
      kind = String.fromCharCode(header[156] || 48);
    const content = bytes.subarray(offset + 512, offset + 512 + size);
    if (content.length !== size) throw Error('Truncated tar entry');
    offset += 512 + Math.ceil(size / 512) * 512;
    if (kind === 'x' || kind === 'g') {
      let at = 0;
      while (at < content.length) {
        const space = content.indexOf(32, at),
          lengthText = content.subarray(at, space).toString('ascii');
        if (space < at || !/^[1-9][0-9]*$/.test(lengthText)) throw Error('Malformed PAX record');
        const length = Number(lengthText),
          end = at + length;
        if (end > content.length || content[end - 1] !== 10 || end <= space + 1)
          throw Error('Truncated PAX record');
        const record = content.subarray(space + 1, end - 1).toString('utf8'),
          equals = record.indexOf('=');
        if (equals < 1) throw Error('Malformed PAX value');
        const key = record.slice(0, equals),
          value = record.slice(equals + 1);
        if (/sparse/i.test(key)) throw Error('Sparse tar entries are unsupported');
        if (key === 'path') {
          if (kind === 'g') throw Error('Global PAX path is unsupported');
          pendingPath = value;
        }
        if (key === 'size') {
          if (kind === 'g' || !/^(0|[1-9][0-9]*)$/.test(value)) throw Error('Unsupported PAX size');
          pendingSize = Number(value);
        }
        at = end;
      }
      continue;
    }
    if (kind === 'L') {
      pendingPath = field(content).replace(/\n$/, '');
      continue;
    }
    const prefix = field(header.subarray(345, 500));
    let name = pendingPath ?? [prefix, field(header.subarray(0, 100))].filter(Boolean).join('/');
    pendingPath = null;
    if (pendingSize !== null && pendingSize !== size) throw Error('Unsupported PAX size override');
    pendingSize = null;
    name = name.replace(/^\.\//, '').replace(/\/$/, '');
    if (!name || name === '.') {
      if (kind === '5') continue;
      throw Error('Empty tar filename');
    }
    if (
      name.startsWith('/') ||
      name.includes('\\') ||
      name.includes('\0') ||
      name.split('/').some((part) => !part || part === '.' || part === '..')
    )
      throw Error('Unsafe tar path');
    if (kind === '5') continue;
    if (kind !== '0') throw Error('Only regular source files and directories are permitted');
    if (files.has(name)) throw Error('Duplicate tar file path');
    files.set(name, { sha256: sha(content), size, mode: octal(header.subarray(100, 108)) });
  }
  if (!ended) throw Error('Tar end markers are missing');
  return files;
}
function compareSourceArchives(buildInput, snapshot) {
  const before = archiveInventory(buildInput),
    after = archiveInventory(snapshot),
    changedPaths = [];
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    if (JSON.stringify(before.get(path)) === JSON.stringify(after.get(path))) continue;
    changedPaths.push({
      path,
      change: !before.has(path) ? 'added' : !after.has(path) ? 'removed' : 'changed',
      approvedDocumentation: /^(README\.md|docs\/.+\.md)$/.test(path),
    });
  }
  return {
    passed: changedPaths.every((row) => row.approvedDocumentation),
    buildInputArchiveSha256: sha(buildInput),
    sourceArchiveSha256: sha(snapshot),
    buildInputFiles: before.size,
    sourceFiles: after.size,
    changedPaths,
  };
}
module.exports = { archiveInventory, compareSourceArchives };
if (require.main === module) {
  try {
    if (![4, 5].includes(process.argv.length))
      throw Error('Use build-input.tar.gz snapshot.tar.gz [report.json]');
    const result = compareSourceArchives(
      fs.readFileSync(process.argv[2]),
      fs.readFileSync(process.argv[3])
    );
    if (process.argv[4]) fs.writeFileSync(process.argv[4], JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
  } catch {
    console.error('Source archive comparison failed; archive contents withheld.');
    process.exitCode = 1;
  }
}
