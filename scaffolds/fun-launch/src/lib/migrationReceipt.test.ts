import { describe, expect, it } from 'vitest';
import bs58 from 'bs58';
import {
  migrationReceiptKey,
  readMigrationReceipt,
  writeMigrationReceipt,
} from './migrationReceipt';

describe('durable browser graduation receipt', () => {
  it('round-trips a public signature/expiry under its network and mint without signed transaction bytes', () => {
    const values = new Map<string, string>(),
      storage = {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => {
          values.set(key, value);
        },
      };
    const key = migrationReceiptKey('localnet', 'mint'),
      receipt = {
        signature: bs58.encode(new Uint8Array(64).fill(1)),
        lastValidBlockHeight: 120,
        savedAt: 1000,
      };
    writeMigrationReceipt(storage, key, receipt);
    expect(readMigrationReceipt(storage, key)).toEqual(receipt);
    expect(readMigrationReceipt(storage, migrationReceiptKey('mainnet-beta', 'mint'))).toBeNull();
    expect(readMigrationReceipt(storage, migrationReceiptKey('localnet', 'different'))).toBeNull();
    expect(Object.keys(JSON.parse(values.get(key)!))).toEqual([
      'signature',
      'lastValidBlockHeight',
      'savedAt',
    ]);
  });
  it('rejects broken storage and malformed or impossible receipt values', () => {
    for (const value of [
      'not-json',
      JSON.stringify({ signature: 'bad', savedAt: 100 }),
      JSON.stringify({
        signature: bs58.encode(new Uint8Array(64).fill(1)),
        savedAt: 100,
        lastValidBlockHeight: -1,
      }),
    ])
      expect(readMigrationReceipt({ getItem: () => value }, 'key')).toBeNull();
    expect(
      readMigrationReceipt(
        {
          getItem: () => {
            throw new Error('storage unavailable');
          },
        },
        'key'
      )
    ).toBeNull();
  });
});
