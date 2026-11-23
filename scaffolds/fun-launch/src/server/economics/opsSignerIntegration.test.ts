import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { Keypair, Transaction, SystemProgram } from '@solana/web3.js';
import type { OperatorPlan } from './operatorStore';
import { NETWORK_GENESIS } from '../../../../../scripts/network-policy.cjs';
import { messageDigest } from './chainEvidence';

const state = vi.hoisted(() => ({
  plan: null as OperatorPlan | null,
  events: [] as string[],
  genesis: '',
  failSend: false,
  switchOnSubmit: false,
  wireSent: '',
}));
vi.mock('../database', () => ({ database: () => ({ end: async () => {}, query: vi.fn() }) }));
vi.mock('@solana/web3.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('@solana/web3.js')>();
  return {
    ...original,
    Connection: class {
      getGenesisHash = async () => state.genesis;
      getEpochInfo = async () => ({ absoluteSlot: 10, blockHeight: 10 });
      sendRawTransaction = async (bytes: Uint8Array) => {
        state.events.push('relay');
        state.wireSent = Buffer.from(bytes).toString('base64');
        if (state.failSend) throw new Error('injected lost relay response');
        return state.plan!.signature!;
      };
    },
  };
});
vi.mock('./operatorStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./operatorStore')>()),
  operatorPlan: async () => state.plan,
  attachOperatorSignature: async (_id: string, wire: string) => {
    const { validateSignedTransaction } = await import('./chainEvidence'),
      signed = validateSignedTransaction(wire, state.plan!.message_digest);
    if (state.plan!.signature && state.plan!.signature !== signed.signature)
      throw Error('different signature');
    if (!state.plan!.signature) {
      state.events.push('persist-signature');
      Object.assign(state.plan!, {
        signature: signed.signature,
        transaction_base64: wire,
        status: 'signed',
      });
    }
    return state.plan;
  },
  markOperatorSubmitted: async () => {
    state.events.push('persist-submission');
    state.plan!.status = 'submitted';
    if (state.switchOnSubmit) state.genesis = NETWORK_GENESIS['mainnet-beta'];
    return state.plan;
  },
  markOperatorUncertain: async () => {
    state.events.push('uncertain');
    state.plan!.status = 'manual_review';
  },
}));
import { runFinancialOps } from './opsCli';
let directory: string, configFile: string;
const payer = Keypair.fromSeed(new Uint8Array(32).fill(9)),
  program = Keypair.fromSeed(new Uint8Array(32).fill(14)).publicKey;
beforeAll(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rinsed-ops-signer-'));
  configFile = path.join(directory, 'command.json');
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      version: 1,
      executable: process.execPath,
      argv: [fileURLToPath(new URL('./fixtures/external-signer-fixture.mjs', import.meta.url))],
      timeoutMs: 3000,
    }),
    { mode: 0o600 }
  );
});
afterAll(() => {
  const absolute = path.resolve(directory);
  if (
    !absolute.startsWith(path.resolve(os.tmpdir()) + path.sep) ||
    !path.basename(absolute).startsWith('rinsed-ops-signer-')
  )
    throw Error('Unsafe temporary cleanup');
  fs.rmSync(absolute, { recursive: true, force: true });
});
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  for (const [name, value] of Object.entries({
    NODE_ENV: 'test',
    NEXT_PUBLIC_NETWORK: 'devnet',
    RPC_URL: 'https://rpc.fixture.invalid',
    LOCAL_VALIDATOR_ENABLED: 'false',
    VAULT_PROGRAM_ID: program.toBase58(),
    VAULT_OPERATOR_PUBLIC_KEY: payer.publicKey.toBase58(),
    FINANCIAL_WORKER_ENABLED: 'true',
  }))
    vi.stubEnv(name, value);
  const mint = Keypair.fromSeed(new Uint8Array(32).fill(11)).publicKey,
    tx = new Transaction({
      feePayer: payer.publicKey,
      recentBlockhash: Keypair.fromSeed(new Uint8Array(32).fill(12)).publicKey.toBase58(),
    });
  tx.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: mint, lamports: 7 }));
  state.plan = {
    id: '11111111-1111-4111-8111-111111111111',
    network_genesis: NETWORK_GENESIS.devnet,
    mint: mint.toBase58(),
    kind: 'setup',
    intent_key: 'test-only',
    transaction_base64: tx
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString('base64'),
    message_digest: messageDigest(tx.serializeMessage()),
    last_valid_block_height: '100',
    metadata: {},
    status: 'prepared',
    signature: null,
    finalized_slot: null,
  };
  state.events = [];
  state.genesis = NETWORK_GENESIS.devnet;
  state.failSend = false;
  state.switchOnSubmit = false;
  state.wireSent = '';
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const args = (command: string, ...extra: string[]) => [
  command,
  '--execute',
  '--id',
  state.plan!.id,
  ...extra,
];
describe('external signer CLI durable boundary', () => {
  it('sign-only invokes a real fixture child, persists verified exact bytes and never broadcasts', async () => {
    await runFinancialOps(args('sign', '--signer-config', configFile));
    expect(state.events).toEqual(['persist-signature']);
    expect(state.plan!.status).toBe('signed');
    expect(state.plan!.signature).toBeTruthy();
    expect(state.wireSent).toBe('');
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('[withheld; export the private plan with --out]')
    );
  });
  it('preserves signed/submitted uncertainty and retries stored bytes without invoking another signer', async () => {
    await runFinancialOps(args('sign', '--signer-config', configFile));
    const wire = state.plan!.transaction_base64,
      signature = state.plan!.signature;
    state.failSend = true;
    await expect(
      runFinancialOps(args('relay', '--signer-command', path.join(directory, 'must-not-run')))
    ).rejects.toThrow('lost relay');
    expect(state.events).toEqual(['persist-signature', 'persist-submission', 'relay', 'uncertain']);
    expect(state.plan!.status).toBe('manual_review');
    state.failSend = false;
    await runFinancialOps(args('relay'));
    expect(state.wireSent).toBe(wire);
    expect(state.plan!.signature).toBe(signature);
    expect(state.events.filter((x) => x === 'persist-signature')).toHaveLength(1);
  });
  it('keeps the signed attempt without sending when genesis changes during SQL submission', async () => {
    state.switchOnSubmit = true;
    await expect(runFinancialOps(args('relay', '--signer-config', configFile))).rejects.toThrow(
      'mainnet'
    );
    expect(state.events).toEqual(['persist-signature', 'persist-submission', 'uncertain']);
    expect(state.wireSent).toBe('');
    expect(state.plan!.status).toBe('manual_review');
  });
  it('never invokes the external signer when mainnet or the worker gate is closed', async () => {
    vi.stubEnv('FINANCIAL_WORKER_ENABLED', 'false');
    await expect(runFinancialOps(args('sign', '--signer-config', configFile))).rejects.toThrow(
      'disabled'
    );
    vi.stubEnv('FINANCIAL_WORKER_ENABLED', 'true');
    vi.stubEnv('NEXT_PUBLIC_NETWORK', 'mainnet-beta');
    state.genesis = NETWORK_GENESIS['mainnet-beta'];
    state.plan!.network_genesis = state.genesis;
    await expect(
      runFinancialOps(args('sign', '--signer-command', path.join(directory, 'must-not-run')))
    ).rejects.toThrow('mainnet');
    expect(state.events).toEqual([]);
    expect(state.plan!.signature).toBeNull();
  });
});
