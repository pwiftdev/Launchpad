import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { digestHeader, MoneroWallet, MoneroWalletError } from './moneroWallet';
import { atomicForLamports, priceSourceFromEnv, rateAtomicPerSol } from './xmrPrice';

const md5 = (value: string) => createHash('md5').update(value).digest('hex');

describe('Monero wallet RPC client', () => {
  it('answers a digest challenge the way RFC 7616 MD5 with qop=auth requires', () => {
    const header = digestHeader(
      'Digest qop="auth",algorithm=MD5,realm="monero-rpc",nonce="abc123",stale=false',
      {
        username: 'masked',
        password: 'secret',
        method: 'POST',
        uri: '/json_rpc',
        cnonce: 'c0ffee',
      }
    );
    const ha1 = md5('masked:monero-rpc:secret'),
      ha2 = md5('POST:/json_rpc');
    expect(header).toContain(`response="${md5(`${ha1}:abc123:00000001:c0ffee:auth:${ha2}`)}"`);
    expect(header).toContain('qop=auth');
  });

  it('retries once with digest login and signs transfers without relaying them', async () => {
    const calls: {
      body: { method: string; params: Record<string, unknown> };
      auth: string | null;
    }[] = [];
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get('Authorization');
      const body = JSON.parse(String(init?.body));
      calls.push({ body, auth });
      if (!auth)
        return new Response('', {
          status: 401,
          headers: { 'www-authenticate': 'Digest qop="auth",realm="r",nonce="n"' },
        });
      return Response.json({
        result: {
          tx_hash_list: ['h1'],
          tx_metadata_list: ['m1'],
          amount_list: [1_000_000],
          fee_list: [30_000],
        },
      });
    });
    const wallet = new MoneroWallet('http://127.0.0.1:18083', 'masked:secret', fetcher as never);
    const signed = await wallet.signTransfers([{ address: 'addr', amount: 1_000_000n }]);
    expect(signed).toEqual({
      txHashes: ['h1'],
      txMetadata: ['m1'],
      amounts: [1_000_000n],
      fees: [30_000n],
    });
    expect(calls[1]!.auth).toMatch(/^Digest username="masked"/);
    expect(calls[1]!.body.params).toMatchObject({ do_not_relay: true, get_tx_metadata: true });
    await expect(wallet.signTransfers([{ address: 'a', amount: 2n ** 60n }])).rejects.toThrow(
      MoneroWalletError
    );
  });

  it('surfaces wallet errors and treats an unknown transaction as not found', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ error: { message: 'Transaction not found.' } })
    );
    const wallet = new MoneroWallet('http://127.0.0.1:18083', undefined, fetcher as never);
    expect(await wallet.confirmations('h')).toBeNull();
    await expect(wallet.balance()).rejects.toThrow('Transaction not found');
  });
});

describe('SOL to XMR rate', () => {
  it('locks piconero per SOL after the fee and always rounds down', () => {
    const rate = rateAtomicPerSol({ solUsd: 150, xmrUsd: 300, source: 't', at: new Date() }, 100);
    expect(rate).toBe(495_000_000_000n);
    expect(atomicForLamports(1_000_000_000n, rate)).toBe(495_000_000_000n);
    expect(atomicForLamports(1n, rate)).toBe(495n);
    expect(() =>
      rateAtomicPerSol({ solUsd: 0, xmrUsd: 1, source: 't', at: new Date() }, 0)
    ).toThrow();
    expect(() =>
      rateAtomicPerSol({ solUsd: 1, xmrUsd: 1, source: 't', at: new Date() }, 1001)
    ).toThrow();
  });

  it('allows a fixed rate only off mainnet', () => {
    expect(() =>
      priceSourceFromEnv({
        MASKED_FIXED_SOL_XMR_RATE: '0.5',
        NEXT_PUBLIC_NETWORK: 'mainnet-beta',
      } as never)
    ).toThrow('test networks');
    expect(priceSourceFromEnv({ MASKED_FIXED_SOL_XMR_RATE: '0.5' } as never)).toBeTypeOf(
      'function'
    );
  });
});
