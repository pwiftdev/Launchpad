import { createHash, createPublicKey, verify } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { claimAuthorizationMessage, type ClaimAuthorization } from '@/lib/rewards';
import { database } from '../database';

export function verifyClaimAuthorization(
  input: ClaimAuthorization,
  origin: string,
  signature: string,
  now = Date.now()
): boolean {
  if (
    !Number.isSafeInteger(input.issuedAt) ||
    input.issuedAt > now + 30_000 ||
    input.issuedAt < now - 300_000 ||
    !/^[A-Za-z0-9+/]{86}==$/.test(signature)
  )
    return false;
  try {
    const signatureBytes = Buffer.from(signature, 'base64');
    if (signatureBytes.length !== 64 || signatureBytes.toString('base64') !== signature)
      return false;
    const address = new PublicKey(input.wallet);
    if (!PublicKey.isOnCurve(address.toBytes())) return false;
    const key = createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), address.toBuffer()]),
      format: 'der',
      type: 'spki',
    });
    return verify(null, Buffer.from(claimAuthorizationMessage(origin, input)), key, signatureBytes);
  } catch {
    return false;
  }
}
export async function recordClaimAuthorization(
  input: ClaimAuthorization,
  origin: string
): Promise<void> {
  const digest = createHash('sha256')
    .update(claimAuthorizationMessage(origin, input))
    .digest('hex');
  const result = await database().query<{ message_digest: string }>(
    `INSERT INTO financial_wallet_authorizations(wallet,request_id,message_digest,expires_at)
     VALUES($1,$2,$3,$4) ON CONFLICT(wallet,request_id) DO UPDATE
     SET message_digest=financial_wallet_authorizations.message_digest
     WHERE financial_wallet_authorizations.message_digest=EXCLUDED.message_digest
     RETURNING message_digest`,
    [input.wallet, input.requestId, digest, new Date(input.issuedAt + 300_000)]
  );
  if (result.rows.length !== 1)
    throw new Error('Claim request conflicts with a previous signed intent');
  await database().query(`DELETE FROM financial_wallet_authorizations WHERE (wallet,request_id) IN
    (SELECT wallet,request_id FROM financial_wallet_authorizations WHERE expires_at<now()-interval '1 day' LIMIT 100)`);
}
