import { PublicKey } from '@solana/web3.js';
import {
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  type DynamicBondingCurveClient,
  type VirtualPool,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { afterEach, expect, it, vi } from 'vitest';
import { createDisplayPoolReader } from './displayPools';

const key = (value: number) => new PublicKey(Buffer.alloc(32, value));
const config = key(1);
const identity = { publicKey: key(2), mint: key(3), config };
const pool = (reserve: number, baseMint = identity.mint) =>
  ({
    poolState: { baseMint, config, quoteReserve: reserve },
  }) as unknown as VirtualPool;

function fixture() {
  const initial = { publicKey: identity.publicKey, account: pool(1) };
  const scan = vi
    .fn<(config: PublicKey) => Promise<(typeof initial)[]>>()
    .mockResolvedValue([initial]);
  const decode = vi.fn((name: string, data: Buffer) => {
    if (name !== 'transferHookPool') throw new Error('Unexpected account variant');
    return pool(2, data.length ? identity.mint : key(4));
  });
  const state = {
    getProgram: () => ({ coder: { accounts: { decode } } }),
    getPoolsByConfig: scan,
  } as unknown as Pick<DynamicBondingCurveClient['state'], 'getProgram' | 'getPoolsByConfig'>;
  const account = {
    owner: DYNAMIC_BONDING_CURVE_PROGRAM_ID,
    executable: false,
    lamports: 1,
    data: Buffer.from([1]),
  };
  const batch = vi.fn().mockResolvedValue([account]);
  return {
    scan,
    batch,
    account,
    initial,
    reader: createDisplayPoolReader({ getMultipleAccountsInfo: batch }, state),
  };
}
afterEach(() => vi.restoreAllMocks());

it('refreshes pool state by address between discovery scans', async () => {
  const f = fixture();
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  expect(await f.reader.list([config])).toEqual([f.initial]);
  now += 10_000;
  expect(await f.reader.list([config])).toEqual([{ ...f.initial, account: pool(2) }]);
  expect(f.batch).toHaveBeenCalledWith([identity.publicKey]);
  expect(f.scan).toHaveBeenCalledTimes(1);
  now += 50_000;
  await f.reader.list([config]);
  expect(f.scan).toHaveBeenCalledTimes(1);
  now += 4 * 60_000;
  await f.reader.list([config]);
  expect(f.scan).toHaveBeenCalledTimes(2);
});

it('does not use a registered address with the wrong owner or mint', async () => {
  const f = fixture();
  f.batch.mockResolvedValueOnce([{ ...f.account, owner: key(5) }]);
  expect(await f.reader.read(identity)).toBeNull();
  f.batch.mockResolvedValueOnce([{ ...f.account, data: Buffer.alloc(0) }]);
  expect(await f.reader.read(identity)).toBeNull();
  expect(await f.reader.read(identity)).toEqual({ ...f.initial, account: pool(2) });
  expect(f.scan).not.toHaveBeenCalled();
});

it('rediscovers a missing pool and does not retain a directory invalidated in flight', async () => {
  const f = fixture();
  let finish!: (rows: (typeof f.initial)[]) => void;
  f.scan.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const previous = f.reader.list([config]);
  f.reader.invalidate();
  finish([f.initial]);
  await previous;
  await f.reader.list([config]);
  expect(f.scan).toHaveBeenCalledTimes(2);
  f.batch.mockResolvedValueOnce([null]);
  expect(await f.reader.list([config])).toEqual([f.initial]);
  expect(f.scan).toHaveBeenCalledTimes(3);
});
