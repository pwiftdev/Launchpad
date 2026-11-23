const { pbkdf2, randomBytes, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const derive = promisify(pbkdf2);
const iterations = 600000;
const pattern = /^pbkdf2-sha256\$600000\$[a-f0-9]{32}\$[a-f0-9]{64}$/;
exports.ADMIN_HASH_PATTERN = pattern;

exports.hashAdminKey = async function hashAdminKey(key) {
  if (typeof key !== 'string' || key.trim().length < 16 || key.length > 256)
    throw new Error('Use an admin key between 16 and 256 characters.');
  const salt = randomBytes(16).toString('hex');
  const digest = await derive(key, Buffer.from(salt, 'hex'), iterations, 32, 'sha256');
  return `pbkdf2-sha256$${iterations}$${salt}$${digest.toString('hex')}`;
};

exports.verifyAdminKey = async function verifyAdminKey(key, encoded) {
  if (
    typeof key !== 'string' ||
    key.length < 16 ||
    key.length > 256 ||
    !pattern.test(encoded || '')
  )
    return false;
  const [, , salt, expected] = encoded.split('$');
  const digest = await derive(key, Buffer.from(salt, 'hex'), iterations, 32, 'sha256');
  return timingSafeEqual(digest, Buffer.from(expected, 'hex'));
};
