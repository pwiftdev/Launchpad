import { describe, expect, it, vi } from 'vitest';
import { ExternalSignerError } from './externalSigner';
import { drainWalletExecutionQueue } from './walletExecutionQueue';
import { WalletMessageExpired } from './walletWorker';
import type { WalletJob } from './walletTypes';

function fixture() {
  const jobs = new Map(
    ['old', 'claim', 'treasury'].map(
      (id) => [id, { id, status: 'prepared', signature: null } as WalletJob] as const
    )
  );
  const row = (id: string) => jobs.get(id)!;
  const worker = {
    required: vi.fn(async (id: string) => ({ ...row(id) })),
    sign: vi.fn(async (id: string) =>
      Object.assign(row(id), { signature: `signature-${id}`, status: 'signed' })
    ),
    relay: vi.fn(async (id: string) => Object.assign(row(id), { status: 'submitted' })),
    recover: vi.fn(async (id: string) =>
      Object.assign(row(id), { signature: null, status: 'queued' })
    ),
    prepare: vi.fn(async (id: string) => Object.assign(row(id), { status: 'prepared' })),
  };
  let active = true;
  return {
    worker,
    row,
    loseLease: () => {
      active = false;
    },
    regainLease: () => {
      active = true;
    },
    run: () => drainWalletExecutionQueue(worker, [...jobs.values()], () => active),
  };
}

describe('automatic wallet execution', () => {
  it('reconciles the existing signature before paying the next claim ahead of treasury', async () => {
    const f = fixture();
    Object.assign(f.row('old'), { signature: 'old-signature', status: 'submitted' });
    f.worker.relay.mockImplementationOnce(async (id) =>
      Object.assign(f.row(id), { status: 'finalized' })
    );
    expect(await f.run()).toMatchObject({ signed: 1, sent: 1 });
    expect(f.worker.relay.mock.calls).toEqual([['old'], ['claim']]);
    expect(f.worker.sign.mock.calls).toEqual([['claim']]);
  });

  it('reuses a durable signature after lease loss between signing and relay', async () => {
    const f = fixture();
    f.worker.sign.mockImplementationOnce(async (id) => {
      f.loseLease();
      return Object.assign(f.row(id), { signature: 'durable', status: 'signed' });
    });
    await f.run();
    expect(f.worker.relay).not.toHaveBeenCalled();
    f.regainLease();
    await f.run();
    expect(f.worker.sign.mock.calls).toEqual([['old']]);
    expect(f.worker.relay.mock.calls).toEqual([['old']]);
  });

  it.each([
    'ambiguous RPC result',
    'failed local write after acknowledgement',
    'crash after signed row committed',
  ])('keeps the same signature and blocks other jobs after a %s', async (boundary) => {
    const f = fixture();
    if (boundary.startsWith('crash')) {
      f.worker.sign.mockImplementationOnce(async (id) => {
        Object.assign(f.row(id), { signature: 'durable', status: 'signed' });
        throw new Error(boundary);
      });
    } else {
      f.worker.relay.mockImplementationOnce(async (id) => {
        Object.assign(f.row(id), { status: 'manual_review' });
        throw new Error(boundary);
      });
    }
    expect(await f.run()).toMatchObject({ sent: 0, alerts: ['WALLET_EXECUTION_DEFERRED'] });
    const signature = f.row('old').signature;
    expect(signature).toBeTruthy();
    await f.run();
    expect(f.worker.sign.mock.calls).toEqual([['old']]);
    expect(f.row('old').signature).toBe(signature);
    expect(f.row('claim').signature).toBeNull();
  });

  it('leaves an unsigned rejection pending and lets another eligible job proceed', async () => {
    const f = fixture();
    f.worker.sign.mockRejectedValueOnce(new ExternalSignerError('SIGNER_PROCESS_FAILED'));
    expect(await f.run()).toEqual({ signed: 1, sent: 1, alerts: ['SIGNER_PROCESS_FAILED'] });
    expect(f.worker.relay.mock.calls).toEqual([['claim']]);
    expect(f.row('old').status).toBe('prepared');
  });

  it('continues only after the recovery path clears an expired signature', async () => {
    const f = fixture();
    Object.assign(f.row('old'), { signature: 'old-signature', status: 'submitted' });
    f.worker.relay.mockRejectedValueOnce(new WalletMessageExpired());
    expect(await f.run()).toMatchObject({ signed: 1, sent: 1 });
    expect(f.worker.recover.mock.calls).toEqual([['old']]);
    expect(f.worker.sign.mock.calls).toEqual([['claim']]);
  });
});
