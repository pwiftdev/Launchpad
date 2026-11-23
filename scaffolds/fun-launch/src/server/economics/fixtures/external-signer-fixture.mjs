/* TEST ONLY: public, deterministic fake keys. Never use this fixture as an operator signer. */
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes) {
  let n = BigInt('0x' + bytes.toString('hex')),
    result = '';
  while (n) {
    result = alphabet[Number(n % 58n)] + result;
    n /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    result = '1' + result;
  }
  return result;
}
const mode = process.argv[2] ?? 'sign';
if (mode === 'hang') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else if (mode === 'overflow') process.stdout.write('x'.repeat(17000));
else if (mode === 'stderr-overflow') process.stderr.write('x'.repeat(5000));
else if (mode === 'fail') {
  process.stderr.write('provider-private-token must-never-be-logged');
  process.exitCode = 7;
} else {
  let input = '';
  process.stdin.on('data', (chunk) => {
    input += chunk;
    if (input.length > 8192) process.exit(8);
  });
  process.stdin.on('end', () => {
    try {
      if (
        mode === 'environment' &&
        [
          'DATABASE_URL',
          'ADMIN_SESSION_SECRET',
          'FINANCIAL_CHECKPOINT_HMAC_KEY',
          'NODE_OPTIONS',
        ].some((key) => process.env[key])
      )
        throw Error();
      if (mode === 'literal' && process.argv[3] !== '$(never-run); "literal argument"')
        throw Error();
      const request = JSON.parse(input),
        bytes = Buffer.from(request.transactionBase64, 'base64');
      let index = 0,
        count = 0,
        shift = 0,
        value;
      do {
        value = bytes[index++];
        count |= (value & 127) << shift;
        shift += 7;
      } while (value & 128);
      const message = Buffer.from(bytes.subarray(index + 64 * count));
      if (mode === 'mutate-message') message[message.length - 1] ^= 1;
      const keys = [9, 10].map((byte) => {
        const seed = Buffer.alloc(32, byte),
          privateKey = createPrivateKey({
            key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
            format: 'der',
            type: 'pkcs8',
          });
        return {
          privateKey,
          address: base58(
            createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32)
          ),
        };
      });
      const signatures = request.requiredSigners.map((address) => {
        const key = keys.find((value) => value.address === address);
        if (!key) throw Error();
        return sign(null, message, key.privateKey);
      });
      if (mode === 'missing-signature') signatures[signatures.length - 1] = Buffer.alloc(64);
      const wire = Buffer.concat([bytes.subarray(0, index), ...signatures, message]);
      const response = {
        version: 1,
        purpose: request.purpose,
        requestId: request.requestId,
        networkGenesis: request.networkGenesis,
        vaultProgramId: request.vaultProgramId,
        executionId: request.executionId,
        messageDigest: request.messageDigest,
        feePayer: request.feePayer,
        requiredSigners: request.requiredSigners,
        signedTransactionBase64: wire.toString('base64'),
        signature: base58(signatures[0]),
      };
      if (mode === 'wrong-network') response.networkGenesis = '11111111111111111111111111111111';
      if (mode === 'wrong-payer') response.feePayer = '11111111111111111111111111111111';
      if (mode === 'wrong-request') response.requestId = 'a'.repeat(64);
      if (mode === 'wrong-signature') response.signature = '1'.repeat(64);
      if (mode === 'extra-secret') response.privateKey = 'forbidden';
      if (mode === 'malformed') return process.stdout.write('{}\n{}');
      process.stdout.write(JSON.stringify(response) + '\n');
    } catch {
      process.stderr.write('fixture failure');
      process.exitCode = 9;
    }
  });
}
