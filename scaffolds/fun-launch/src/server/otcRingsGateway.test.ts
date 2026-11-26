import { expect, it } from 'vitest';
import type { RingsRoom } from '@/lib/otcRingsRoom';
import { ringsGatewayRequest, ringsGatewayTarget } from './otcRingsGateway';

const rpc = new URL('https://mainnet.helius-rpc.com/?api-key=server-only');
const proof = '/v1/spr/prove/transfer_confidential_1_2/indexed';
const base = { id: '19a06770-c274-4fee-bab9-56bb6f7e44bd', search: '', method: 'POST' as const };
const room = { side: 'maker', maker: { funding: null } } as RingsRoom;

it('proxies encrypted proofs to the pinned endpoint and refuses plaintext or arbitrary circuits', () => {
  const headers = {
    'content-type': 'application/octet-stream',
    'spr-tee': 'v1',
    'spr-tee-enc': 'ab'.repeat(32),
    'x-sync': 'true',
  };
  const request = ringsGatewayRequest.parse({ ...base, path: proof, headers, body: 'AQID' });
  const routed = ringsGatewayTarget(request, room, rpc);
  expect(routed.url.origin).toBe(rpc.origin);
  expect(routed.url.pathname).toBe(proof);
  expect(routed.body).toEqual(new Uint8Array([1, 2, 3]));
  expect(() =>
    ringsGatewayTarget({ ...request, path: '/v1/spr/prove/some-other-key/indexed' }, room, rpc)
  ).toThrow();
  expect(() =>
    ringsGatewayTarget({ ...request, headers: { 'content-type': 'application/json' } }, room, rpc)
  ).toThrow();
  expect(() =>
    ringsGatewayTarget({ ...request, search: '?api-key=override' }, room, rpc)
  ).toThrow();
});

it('accepts the indexer request shape but rejects other methods and unbound transaction bytes', () => {
  const headers = { 'content-type': 'application/json' as const };
  const method = 'getShieldedTransactionsBySignature';
  const path = `/v1/spr/${method}`;
  const body = JSON.stringify({ jsonrpc: '2.0', method, params: { txSignature: 'fixture' } });
  expect(ringsGatewayTarget({ ...base, path, headers, body }, room, rpc).url.pathname).toBe(path);
  expect(() => ringsGatewayTarget({ ...base, path: '/', headers, body }, room, rpc)).toThrow();
  expect(() =>
    ringsGatewayTarget(
      {
        ...base,
        path: '/',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', method: 'sendTransaction', params: ['AA=='] }),
      },
      room,
      rpc
    )
  ).toThrow();
});
