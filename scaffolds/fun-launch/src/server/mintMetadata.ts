export function readBorshString(data: Buffer, offset: number): [string, number] {
  if (offset < 0 || offset + 4 > data.length) throw new Error('Invalid metadata');
  const len = data.readUInt32LE(offset);
  if (len > 2048 || offset + 4 + len > data.length) throw new Error('Invalid metadata length');
  const value = data
    .subarray(offset + 4, offset + 4 + len)
    .toString('utf8')
    .replace(/\0/g, '')
    .trim();
  return [value, offset + 4 + len];
}
