import { getTransactionDecoder } from '@solana/kit';
import { z } from 'zod';
import { dealAddress } from '@/lib/otcRingsDeposit';
import { ringsBase64, ringsBytes } from '@/lib/otcRingsPackets';
import { wireBytes, type RingsRoom } from '@/lib/otcRingsRoom';
import { SocialError } from './profileStore';

const proof = /^\/v1\/spr\/prove\/transfer_confidential_1_2(?:\/(indexed|status))?$/;
const rpcMethods = new Set([
  'getGenesisHash',
  'getAccountInfo',
  'getBalance',
  'getFeeForMessage',
  'getLatestBlockhash',
  'getSignatureStatuses',
  'getBlockHeight',
  'isBlockhashValid',
  'sendTransaction',
]);
const indexerMethods = new Set(['getShieldedTransactionsBySignature']);
const headersSchema = z.strictObject({
  'content-type': z
    .enum(['application/json', 'application/json; charset=utf-8', 'application/octet-stream'])
    .optional(),
  'spr-tee': z.literal('v1').optional(),
  'spr-tee-enc': z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  'spr-tee-ciphertext': z
    .string()
    .regex(/^[a-f0-9]+$/)
    .max(4096)
    .optional(),
  'x-sync': z.literal('true').optional(),
  'x-async': z.literal('true').optional(),
});
export const ringsGatewayRequest = z.strictObject({
  id: z.uuid(),
  path: z.string().max(145),
  method: z.enum(['GET', 'POST']),
  headers: headersSchema,
  search: z.string().max(265),
  body: z.string().max(96000).optional(),
});

function denied() {
  return new SocialError('The Rings request is not allowed.', 400);
}

function allowBroadcast(value: unknown, room: RingsRoom) {
  const raw = wireBytes(5464).safeParse(value);
  if (!raw.success) throw denied();
  if (
    [room[room.side].funding, room[room.side].withdrawal, room[room.side].reserve].some(
      (packet) => packet?.transaction === raw.data
    )
  )
    return;
  try {
    const { attempt } = room;
    if (!attempt?.maker || !attempt.taker) throw denied();
    const transaction = getTransactionDecoder().decode(ringsBytes(raw.data));
    const message = ringsBase64(transaction.messageBytes);
    if (
      Object.keys(transaction.signatures).length !== 2 ||
      (['maker', 'taker'] as const).some((side) => {
        const key = dealAddress(room[side].key).solanaAddress();
        const signature = transaction.signatures[key];
        return (
          !signature ||
          attempt[side]?.message !== message ||
          attempt[side]?.signature !== ringsBase64(signature)
        );
      })
    )
      throw denied();
  } catch {
    throw denied();
  }
}

export function ringsGatewayTarget(
  input: z.infer<typeof ringsGatewayRequest>,
  room: RingsRoom,
  rpc: URL
) {
  const { path, method, search, headers } = input;
  const match = proof.exec(path);
  const operation = path.slice('/v1/spr/'.length);
  const query = new URLSearchParams(search);
  let body: string | Uint8Array<ArrayBuffer> | undefined = input.body;
  const local = rpc.protocol === 'http:';
  if (path === '/' || (path === `/v1/spr/${operation}` && indexerMethods.has(operation))) {
    if (method !== 'POST' || search || headers['spr-tee'] || typeof body !== 'string')
      throw denied();
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      throw denied();
    }
    if (payload?.jsonrpc !== '2.0') throw denied();
    if (path === '/') {
      if (
        !rpcMethods.has(payload.method) ||
        (payload.params !== undefined && !Array.isArray(payload.params))
      )
        throw denied();
    } else if (
      payload.method !== operation ||
      !payload.params ||
      typeof payload.params !== 'object' ||
      Array.isArray(payload.params)
    ) {
      throw denied();
    }
    if (payload.method === 'sendTransaction') allowBroadcast(payload.params?.[0], room);
  } else if (path === '/v1/spr/attestation') {
    if (
      local ||
      method !== 'GET' ||
      body !== undefined ||
      [...query.keys()].join() !== 'nonce' ||
      !/^[a-f0-9]{64}$/.test(query.get('nonce') ?? '')
    )
      throw denied();
  } else if (match) {
    if (match[1] === 'status') {
      if (
        method !== 'GET' ||
        body !== undefined ||
        [...query.keys()].join() !== 'jobId' ||
        !/^[A-Za-z0-9_-]{1,256}$/.test(query.get('jobId') ?? '') ||
        (!local && !headers['spr-tee-ciphertext'])
      )
        throw denied();
    } else {
      if (
        method !== 'POST' ||
        search ||
        !body ||
        (!local && headers['content-type'] !== 'application/octet-stream')
      )
        throw denied();
      if (!local) body = new Uint8Array(Buffer.from(z.base64().parse(body), 'base64'));
    }
    if (!local && (headers['spr-tee'] !== 'v1' || !headers['spr-tee-enc'])) throw denied();
  } else {
    throw denied();
  }

  const url = new URL(rpc);
  if (local && path !== '/') url.port = match ? '19301' : '19784';
  url.pathname = local && path !== '/' ? `/${operation}` : path;
  for (const [key, value] of query) url.searchParams.append(key, value);
  return { url, body, prove: !!match && method === 'POST' };
}
