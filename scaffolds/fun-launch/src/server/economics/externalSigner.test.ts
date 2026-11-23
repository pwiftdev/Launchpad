import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, afterAll, afterEach, describe, it, expect, vi } from 'vitest';
import {
  Keypair,
  Transaction,
  SystemProgram,
  TransactionInstruction,
  type Connection,
} from '@solana/web3.js';
import {
  externalSignerRequest,
  requestExternalSignature,
  loadExternalSignerCommand,
  type ExternalSignerExecution,
  type ExternalSignerCommand,
} from './externalSigner';
import { messageDigest, validateSignedTransaction } from './chainEvidence';

const fixturePath = fileURLToPath(
  new URL('./fixtures/external-signer-fixture.mjs', import.meta.url)
);
let temporary: string;
beforeAll(() => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rinsed-signer-'));
});
afterAll(() => {
  const absolute = path.resolve(temporary),
    allowed = path.resolve(os.tmpdir()) + path.sep;
  if (!absolute.startsWith(allowed) || !path.basename(absolute).startsWith('rinsed-signer-'))
    throw Error('Unsafe temporary cleanup');
  fs.rmSync(absolute, { recursive: true, force: true });
});
it('loads the deployment signer-command example through the real command parser', () => {
  const example = JSON.parse(
    fs.readFileSync(
      new URL('../../../../../deploy/plzzz-bond.signer-command.example.json', import.meta.url),
      'utf8'
    )
  );
  const file = path.join(temporary, 'deployment-command.json');
  fs.writeFileSync(file, JSON.stringify({ ...example, executable: process.execPath }), {
    mode: 0o600,
  });
  const command = loadExternalSignerCommand({ configFile: file });
  expect(command.argv).toEqual(example.argv);
  expect(command.timeoutMs).toBe(30000);
});
afterEach(() => vi.unstubAllEnvs());
const key = (value: number) => Keypair.fromSeed(new Uint8Array(32).fill(value));
function execution(two = false): ExternalSignerExecution {
  const payer = key(9),
    mint = key(11).publicKey,
    tx = new Transaction({
      feePayer: payer.publicKey,
      recentBlockhash: key(12).publicKey.toBase58(),
    });
  tx.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: mint, lamports: 7 }));
  if (two)
    tx.add(
      new TransactionInstruction({
        programId: SystemProgram.programId,
        keys: [{ pubkey: key(10).publicKey, isSigner: true, isWritable: false }],
        data: Buffer.alloc(0),
      })
    );
  return {
    networkGenesis: key(13).publicKey.toBase58(),
    vaultProgramId: key(14).publicKey.toBase58(),
    executionId: '11111111-1111-4111-8111-111111111111',
    executionKind: 'setup',
    mint: mint.toBase58(),
    messageDigest: messageDigest(tx.serializeMessage()),
    transactionBase64: tx
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString('base64'),
    lastValidBlockHeight: 100,
    feePayer: payer.publicKey.toBase58(),
    requiredSigners: two
      ? [payer.publicKey.toBase58(), key(10).publicKey.toBase58()]
      : [payer.publicKey.toBase58()],
  };
}
const command = (mode = 'sign', timeoutMs = 3000): ExternalSignerCommand => ({
  executable: process.execPath,
  argv: [fixturePath, mode],
  timeoutMs,
});
function rpc(value = execution()): Pick<Connection, 'getGenesisHash' | 'getEpochInfo'> {
  return {
    getGenesisHash: vi.fn(async () => value.networkGenesis),
    getEpochInfo: vi.fn(async () => ({
      absoluteSlot: 10,
      blockHeight: 10,
      epoch: 0,
      slotIndex: 0,
      slotsInEpoch: 100,
      transactionCount: 0,
    })),
  };
}
describe('bounded external sign-only transport', () => {
  it('round-trips a real Ed25519 child signer and independently verifies exact bytes/all required signatures', async () => {
    const value = execution(true),
      network = rpc(value),
      first = externalSignerRequest(value);
    expect(externalSignerRequest({ ...value }).requestId).toBe(first.requestId);
    const result = await requestExternalSignature({
      command: command(),
      execution: value,
      rpc: network,
    });
    expect(
      validateSignedTransaction(result.signedTransactionBase64, value.messageDigest).signature
    ).toBe(result.signature);
    expect(result.requestId).toBe(first.requestId);
    expect(network.getGenesisHash).toHaveBeenCalledTimes(2);
    await expect(
      requestExternalSignature({
        command: command('missing-signature'),
        execution: value,
        rpc: rpc(value),
      })
    ).rejects.toMatchObject({ code: 'SIGNER_RESPONSE_INVALID' });
    const publicOnly = externalSignerRequest({
      ...value,
      secretKey: 'never copy unknown properties',
    } as ExternalSignerExecution);
    expect(JSON.stringify(publicOnly)).not.toContain('never copy');
  });
  it.each([
    'mutate-message',
    'missing-signature',
    'wrong-network',
    'wrong-payer',
    'wrong-request',
    'wrong-signature',
    'extra-secret',
    'malformed',
  ])('rejects %s responses before returning signed material', async (mode) => {
    await expect(
      requestExternalSignature({ command: command(mode), execution: execution(), rpc: rpc() })
    ).rejects.toMatchObject({ code: 'SIGNER_RESPONSE_INVALID' });
  });
  it('does not expose inherited web/database/checkpoint secrets and passes argv literally without a shell', async () => {
    for (const name of ['DATABASE_URL', 'ADMIN_SESSION_SECRET', 'FINANCIAL_CHECKPOINT_HMAC_KEY'])
      vi.stubEnv(name, 'private-marker');
    const value = execution();
    await expect(
      requestExternalSignature({
        command: command('environment'),
        execution: value,
        rpc: rpc(value),
      })
    ).resolves.toHaveProperty('signature');
    await expect(
      requestExternalSignature({
        command: {
          ...command('literal'),
          argv: [fixturePath, 'literal', '$(never-run); "literal argument"'],
        },
        execution: value,
        rpc: rpc(value),
      })
    ).resolves.toHaveProperty('signature');
  });
  it.each(['overflow', 'stderr-overflow', 'fail', 'hang'])(
    'bounds %s and returns only fixed sanitized errors',
    async (mode) => {
      const before = Date.now();
      const error = await requestExternalSignature({
        command: command(mode, mode === 'hang' ? 500 : 3000),
        execution: execution(),
        rpc: rpc(),
      }).catch((error) => error as Error);
      expect(error).toHaveProperty(
        'code',
        mode === 'hang'
          ? 'SIGNER_TIMEOUT'
          : mode === 'fail'
            ? 'SIGNER_PROCESS_FAILED'
            : 'SIGNER_OUTPUT_LIMIT'
      );
      expect(String(error)).not.toContain('provider-private-token');
      expect(Date.now() - before).toBeLessThan(5000);
    }
  );
  it('rejects changed live genesis, expired preparation and signatures that expire during the external operation', async () => {
    const value = execution(),
      before = rpc(value);
    vi.mocked(before.getGenesisHash).mockResolvedValue('11111111111111111111111111111111');
    await expect(
      requestExternalSignature({ command: command(), execution: value, rpc: before })
    ).rejects.toMatchObject({ code: 'SIGNER_NETWORK_CHANGED' });
    const after = rpc(value);
    vi.mocked(after.getGenesisHash)
      .mockResolvedValueOnce(value.networkGenesis)
      .mockResolvedValueOnce('11111111111111111111111111111111');
    await expect(
      requestExternalSignature({ command: command(), execution: value, rpc: after })
    ).rejects.toMatchObject({ code: 'SIGNER_NETWORK_CHANGED' });
    for (const phase of ['before', 'after']) {
      const chain = rpc(value);
      vi.mocked(chain.getEpochInfo).mockResolvedValue({
        absoluteSlot: 101,
        blockHeight: 101,
        epoch: 0,
        slotIndex: 0,
        slotsInEpoch: 100,
        transactionCount: 0,
      });
      if (phase === 'after')
        vi.mocked(chain.getEpochInfo).mockResolvedValueOnce({
          absoluteSlot: 10,
          blockHeight: 10,
          epoch: 0,
          slotIndex: 0,
          slotsInEpoch: 100,
          transactionCount: 0,
        });
      await expect(
        requestExternalSignature({ command: command(), execution: value, rpc: chain })
      ).rejects.toMatchObject({ code: 'SIGNER_PLAN_EXPIRED' });
    }
  });
  it('refuses payer/digest/required-signers changes and does not pass already signed messages to the signer', async () => {
    const value = execution();
    for (const change of [
      { feePayer: key(10).publicKey.toBase58() },
      { messageDigest: 'a'.repeat(64) },
      { requiredSigners: [key(10).publicKey.toBase58()] },
    ])
      expect(() => externalSignerRequest({ ...value, ...change })).toThrow('durable unsigned');
    const result = await requestExternalSignature({
      command: command(),
      execution: value,
      rpc: rpc(value),
    });
    expect(() =>
      externalSignerRequest({ ...value, transactionBase64: result.signedTransactionBase64 })
    ).toThrow('durable unsigned');
  });
  it('loads bounded owner-private config references and refuses shells, unknown fields and unsafe permissions', () => {
    const file = path.join(temporary, 'signer.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        executable: process.execPath,
        argv: [fixturePath],
        timeoutMs: 500,
      }),
      { mode: 0o600 }
    );
    expect(loadExternalSignerCommand({ configFile: file })).toEqual({
      executable: process.execPath,
      argv: [fixturePath],
      timeoutMs: 500,
    });
    expect(() =>
      loadExternalSignerCommand({ command: process.execPath, configFile: file })
    ).toThrow('configuration');
    expect(() => loadExternalSignerCommand({ command: 'node --eval unsafe' })).toThrow(
      'configuration'
    );
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        executable: process.execPath,
        argv: [],
        privateKey: 'must never be accepted',
      })
    );
    expect(() => loadExternalSignerCommand({ configFile: file })).toThrow('configuration');
    if (process.platform !== 'win32') {
      fs.writeFileSync(
        file,
        JSON.stringify({ version: 1, executable: process.execPath, argv: [] })
      );
      fs.chmodSync(file, 0o644);
      expect(() => loadExternalSignerCommand({ configFile: file })).toThrow('configuration');
    }
  });
  it('cancels an in-flight external process and never returns its output', async () => {
    const controller = new AbortController(),
      promise = requestExternalSignature({
        command: command('hang'),
        execution: execution(),
        rpc: rpc(),
        signal: controller.signal,
      });
    setTimeout(() => controller.abort(), 100);
    await expect(promise).rejects.toMatchObject({ code: 'SIGNER_CANCELLED' });
  });
});
