import { expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { buildSync } from 'esbuild';
import { fileURLToPath } from 'node:url';
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  type Connection,
  VersionedTransaction,
  TransactionMessage,
  AddressLookupTableAccount,
  type AccountInfo,
} from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, NATIVE_MINT } from '@solana/spl-token';
import {
  allocateCollectedFeesInstruction,
  approveConfigInstruction,
  bindMigrationInstruction,
  claimCreatorInstruction,
  claimPlatformInstruction,
  collectFeesInstruction,
  createEpochInstruction,
  executeBuybackBurnInstruction,
  initializeVaultInstruction,
  setPausedInstruction,
  vaultAddresses,
} from '@/lib/vault/client';
import {
  operatorSignerPolicy,
  signRequestId,
  validateOperatorSignRequest,
} from './operatorSignerPolicy';
import { messageDigest, validateSignedTransaction } from './chainEvidence';
import { requestExternalSignature } from './externalSigner';

const pub = (byte: number) => new PublicKey(new Uint8Array(32).fill(byte));
function fixture(kind: 'setup' | 'funding' | 'epoch' | 'buyback' | 'platform_claim' = 'epoch') {
  const operator = Keypair.fromSeed(new Uint8Array(32).fill(1)),
    treasury = Keypair.fromSeed(new Uint8Array(32).fill(2)),
    program = pub(3),
    mint = pub(4),
    config = pub(5),
    pool = pub(6),
    addresses = vaultAddresses(program, mint),
    loader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
  const code = Buffer.from('7f454c460102030405', 'hex'),
    programData = PublicKey.findProgramAddressSync([program.toBuffer()], loader)[0];
  const programBytes = Buffer.alloc(36);
  programBytes.writeUInt32LE(2);
  programData.toBuffer().copy(programBytes, 4);
  const data = Buffer.alloc(45 + code.length);
  data.writeUInt32LE(3);
  data[12] = 1;
  operator.publicKey.toBuffer().copy(data, 13);
  code.copy(data, 45);
  const settings = Buffer.alloc(107);
  settings.write('RSET0001');
  settings[8] = 1;
  operator.publicKey.toBuffer().copy(settings, 11);
  operator.publicKey.toBuffer().copy(settings, 43);
  treasury.publicKey.toBuffer().copy(settings, 75);
  const coin = Buffer.alloc(347);
  coin.write('RCOIN001');
  coin[8] = 1;
  coin[10] = 1;
  mint.toBuffer().copy(coin, 11);
  pool.toBuffer().copy(coin, 43);
  config.toBuffer().copy(coin, 75);
  coin.writeBigInt64LE(1n, 139);
  coin.writeBigUInt64LE(100000n, 147);
  coin.writeBigUInt64LE(100000n, 163);
  coin.writeBigUInt64LE(100000n, 171);
  const native = (data: Buffer) => ({
    owner: program,
    executable: false,
    data,
    lamports: 10000000,
    rentEpoch: 0,
  });
  const clock = Buffer.alloc(40);
  clock.writeBigInt64LE(100n, 32);
  const rpc = {
    getGenesisHash: vi.fn().mockResolvedValue('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'),
    getEpochInfo: vi.fn().mockResolvedValue({ absoluteSlot: 100, blockHeight: 100 }),
    getMultipleAccountsInfoAndContext: vi.fn().mockImplementation(async (keys: PublicKey[]) => ({
      context: { slot: 100 },
      value:
        keys.length === 1
          ? [
              {
                ...native(clock),
                owner: new PublicKey('Sysvar1111111111111111111111111111111111111'),
              },
            ]
          : [
              { ...native(programBytes), owner: loader, executable: true },
              { ...native(data), owner: loader },
              native(settings),
              native(coin),
            ],
    })),
    isBlockhashValid: vi.fn().mockResolvedValue({ context: { slot: 100 }, value: true }),
    getFeeForMessage: vi.fn().mockResolvedValue({ context: { slot: 100 }, value: 5000 }),
  };
  const policy = {
    version: 1 as const,
    role: kind === 'platform_claim' ? ('treasury' as const) : ('operator' as const),
    networkGenesis: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' as const,
    vaultProgramId: program.toBase58(),
    deployedProgramDataSha256: createHash('sha256').update(code).digest('hex'),
    governor: operator.publicKey.toBase58(),
    operator: operator.publicKey.toBase58(),
    treasury: treasury.publicKey.toBase58(),
    upgradeAuthority: operator.publicKey.toBase58(),
    keyFile: '/private/operator.json',
    approvedBuybacks: [] as { messageDigest: string; minimumTokens: string; expiresAt: number }[],
    rpcUrl: 'https://rpc.example.test',
    limits: {
      maximumFeeLamports: '10000',
      maximumFundingLamports: '10000',
      maximumBuybackLamports: '10000',
      maximumEpochLamports: '10000',
      maximumPlatformLamports: '10000',
      maximumBuybackLifetimeSeconds: 30,
    },
  };
  const payer = kind === 'platform_claim' ? treasury : operator;
  const instruction =
    kind === 'epoch'
      ? createEpochInstruction({
          programId: program,
          mint,
          operator: operator.publicKey,
          epoch: 1n,
          root: Buffer.alloc(32, 1),
          snapshotSlot: 90n,
          snapshotDigest: Buffer.alloc(32, 2),
          total: 100n,
        })
      : kind === 'funding'
        ? allocateCollectedFeesInstruction({
            programId: program,
            mint,
            operator: operator.publicKey,
            fundingId: Buffer.alloc(32, 1),
            commitment: Buffer.alloc(32, 2),
            events: [{ phase: 1, net: 100n }],
          })
        : kind === 'buyback'
          ? executeBuybackBurnInstruction({
              programId: program,
              mint,
              operator: operator.publicKey,
              dexProgram: new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN'),
              swapAccounts: [],
              nonce: 0n,
              amount: 100n,
              minOut: 99n,
              deadline: 120n,
              route: 'dbc',
              swapData: Buffer.alloc(8, 1),
            })
          : kind === 'platform_claim'
            ? claimPlatformInstruction(program, mint, treasury.publicKey, 100n)
            : createAssociatedTokenAccountIdempotentInstruction(
                operator.publicKey,
                addresses.quoteAccount,
                addresses.coin,
                NATIVE_MINT
              );
  const transaction = new Transaction({
    feePayer: payer.publicKey,
    recentBlockhash: pub(9).toBase58(),
  }).add(instruction);
  if (kind === 'buyback')
    policy.approvedBuybacks.push({
      messageDigest: messageDigest(transaction.serializeMessage()),
      minimumTokens: '99',
      expiresAt: 130,
    });
  function request(tx = transaction) {
    const wire = tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
      base = {
        version: 1 as const,
        purpose: 'rinsed-financial-sign-only' as const,
        networkGenesis: policy.networkGenesis,
        vaultProgramId: program.toBase58(),
        executionId: '11111111-1111-4111-8111-111111111111',
        executionKind: kind,
        mint: mint.toBase58(),
        messageDigest: messageDigest(tx.serializeMessage()),
        feePayer: payer.publicKey.toBase58(),
        requiredSigners: [payer.publicKey.toBase58()],
        lastValidBlockHeight: 150,
        transactionBase64: wire.toString('base64'),
      };
    return { ...base, requestId: signRequestId(base) };
  }
  return {
    operator,
    treasury,
    payer,
    program,
    mint,
    config,
    pool,
    addresses,
    settings,
    coin,
    programBytes,
    data,
    clock,
    rpc,
    policy,
    transaction,
    request,
    call: (input = request(), policyInput: unknown = policy) =>
      validateOperatorSignRequest(input, policyInput, rpc as unknown as Connection),
  };
}
it.each(['setup', 'funding', 'epoch', 'buyback', 'platform_claim'] as const)(
  'verifies a bounded %s request before any key is loaded',
  async (kind) => {
    const f = fixture(kind),
      result = await f.call();
    result.transaction.sign([f.payer]);
    const wire = Buffer.from(result.transaction.serialize()).toString('base64');
    expect(validateSignedTransaction(wire, f.request().messageDigest).signature).toBeTruthy();
    expect(f.rpc.getGenesisHash).toHaveBeenCalledTimes(2);
  }
);
it.each(['initialize', 'approve', 'pause', 'creator', 'transfer'] as const)(
  'rejects %s even when the operator key also owns governance',
  async (action) => {
    const f = fixture('setup'),
      instruction =
        action === 'initialize'
          ? initializeVaultInstruction({
              programId: f.program,
              governor: f.operator.publicKey,
              operator: f.operator.publicKey,
              treasury: f.treasury.publicKey,
            })
          : action === 'approve'
            ? approveConfigInstruction(f.program, f.operator.publicKey, f.config)
            : action === 'pause'
              ? setPausedInstruction(f.program, f.operator.publicKey, false)
              : action === 'creator'
                ? claimCreatorInstruction(f.program, f.mint, f.operator.publicKey, 1n)
                : SystemProgram.transfer({
                    fromPubkey: f.operator.publicKey,
                    toPubkey: pub(19),
                    lamports: 1,
                  });
    const tx = new Transaction({
      feePayer: f.operator.publicKey,
      recentBlockhash: pub(9).toBase58(),
    }).add(instruction);
    await expect(f.call(f.request(tx))).rejects.toThrow();
  }
);
it.each(['digest', 'request', 'payer', 'mint', 'kind', 'signature', 'lookup'] as const)(
  'rejects altered %s bindings',
  async (field) => {
    const f = fixture(),
      r = f.request();
    if (field === 'digest') r.messageDigest = 'a'.repeat(64);
    if (field === 'request') r.requestId = 'b'.repeat(64);
    if (field === 'payer') r.feePayer = f.treasury.publicKey.toBase58();
    if (field === 'mint') {
      r.mint = pub(20).toBase58();
      r.requestId = signRequestId(r);
    }
    if (field === 'kind') {
      r.executionKind = 'buyback';
      r.requestId = signRequestId(r);
    }
    if (field === 'signature') {
      f.transaction.partialSign(f.payer);
      Object.assign(r, f.request());
    }
    if (field === 'lookup') {
      const tx = new VersionedTransaction(f.transaction.compileMessage());
      tx.message.header.numRequiredSignatures = 2;
      r.transactionBase64 = Buffer.from(tx.serialize()).toString('base64');
    }
    await expect(f.call(r)).rejects.toThrow();
  }
);
it.each([
  'code',
  'programdata',
  'governor',
  'operator',
  'treasury',
  'mint',
  'paused',
  'expiry',
  'blockhash',
  'stale',
  'fee',
  'network',
] as const)('rejects invalid finalized %s evidence', async (field) => {
  const f = fixture();
  if (field === 'code') f.data[f.data.length - 1] = f.data[f.data.length - 1]! ^ 1;
  if (field === 'programdata') f.programBytes[4] = f.programBytes[4]! ^ 1;
  if (field === 'governor') pub(20).toBuffer().copy(f.settings, 11);
  if (field === 'operator') pub(20).toBuffer().copy(f.settings, 43);
  if (field === 'treasury') pub(20).toBuffer().copy(f.settings, 75);
  if (field === 'mint') pub(20).toBuffer().copy(f.coin, 11);
  if (field === 'paused') f.settings[10] = 1;
  if (field === 'expiry')
    f.rpc.getEpochInfo.mockResolvedValue({ absoluteSlot: 100, blockHeight: 151 });
  if (field === 'blockhash')
    f.rpc.isBlockhashValid.mockResolvedValue({ context: { slot: 100 }, value: false });
  if (field === 'stale')
    f.rpc.getFeeForMessage.mockResolvedValue({ context: { slot: 99 }, value: 5000 });
  if (field === 'fee')
    f.rpc.getFeeForMessage.mockResolvedValue({ context: { slot: 100 }, value: 10001 });
  if (field === 'network')
    f.rpc.getGenesisHash
      .mockResolvedValueOnce(f.policy.networkGenesis)
      .mockResolvedValueOnce(pub(22).toBase58());
  await expect(f.call()).rejects.toThrow();
});
it.each(['funding', 'buyback', 'epoch', 'platform_claim'] as const)(
  'enforces the configured %s spending cap',
  async (kind) => {
    const f = fixture(kind);
    Object.assign(f.policy.limits, {
      maximumFundingLamports: '99',
      maximumBuybackLamports: '99',
      maximumEpochLamports: '99',
      maximumPlatformLamports: '99',
    });
    await expect(f.call()).rejects.toThrow();
  }
);
it('permits canonical native migration binding but refuses extra top-level instructions and altered ATA owners', async () => {
  const f = fixture('setup');
  const bind = bindMigrationInstruction({
    programId: f.program,
    mint: f.mint,
    operator: f.operator.publicKey,
    dbcPool: f.pool,
    config: f.config,
    pool: pub(20),
    position: pub(21),
    nftAccount: pub(22),
  });
  const tx = new Transaction({
    feePayer: f.operator.publicKey,
    recentBlockhash: pub(9).toBase58(),
  }).add(bind);
  await expect(f.call(f.request(tx))).resolves.toBeTruthy();
  tx.add(
    SystemProgram.transfer({ fromPubkey: f.operator.publicKey, toPubkey: pub(23), lamports: 1 })
  );
  await expect(f.call(f.request(tx))).rejects.toThrow();
  f.transaction.instructions[0]!.keys[2]!.pubkey = pub(23);
  await expect(f.call()).rejects.toThrow();
});
it('validates the canonical collection instruction shape and fee-authority account', async () => {
  const f = fixture('funding'),
    instruction = collectFeesInstruction({
      programId: f.program,
      mint: f.mint,
      operator: f.operator.publicKey,
      dexProgram: new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN'),
      claimAccounts: [],
      fundingId: Buffer.alloc(32, 1),
      commitment: Buffer.alloc(32, 2),
      events: [{ phase: 0, net: 100n }],
    });
  const tx = new Transaction({
    feePayer: f.operator.publicKey,
    recentBlockhash: pub(9).toBase58(),
  }).add(instruction);
  await expect(f.call(f.request(tx))).resolves.toBeTruthy();
  instruction.keys[5]!.pubkey = pub(29);
  await expect(f.call(f.request(tx))).rejects.toThrow();
});
it('refuses treasury/operator role substitution and non-mainnet or unbounded policy fields', async () => {
  const f = fixture();
  await expect(f.call(f.request(), { ...f.policy, role: 'treasury' })).rejects.toThrow();
  expect(
    operatorSignerPolicy.safeParse({ ...f.policy, networkGenesis: pub(24).toBase58() }).success
  ).toBe(false);
  expect(
    operatorSignerPolicy.safeParse({
      ...f.policy,
      limits: { ...f.policy.limits, maximumFeeLamports: '18446744073709551616' },
    }).success
  ).toBe(false);
});

it('runs the bundled reference signer in a separate process with fixture-only keys and no network sends', async () => {
  const tempRoot = fs.realpathSync(os.tmpdir());
  const folder = fs.mkdtempSync(path.join(tempRoot, 'rinsed-reference-signer-'));
  try {
    const f = fixture(),
      entry = path.join(folder, 'signer.cjs'),
      keyFile = path.join(folder, 'operator.json'),
      policyFile = path.join(folder, 'policy.json'),
      stateFile = path.join(folder, 'rpc.json'),
      preload = path.join(folder, 'rpc-fixture.cjs'),
      marker = path.join(folder, 'key-read.json');
    buildSync({
      entryPoints: [fileURLToPath(new URL('./operatorSignerEntry.ts', import.meta.url))],
      outfile: entry,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      external: ['bufferutil', 'utf-8-validate'],
      tsconfig: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
      logLevel: 'silent',
    });
    fs.writeFileSync(keyFile, JSON.stringify([...f.payer.secretKey]), { mode: 0o600 });
    fs.writeFileSync(policyFile, JSON.stringify({ ...f.policy, keyFile }), { mode: 0o600 });
    const accounts = (
      await f.rpc.getMultipleAccountsInfoAndContext([f.program, f.program, f.program, f.program])
    ).value.map((row: AccountInfo<Buffer>) => ({
      ...row,
      owner: row.owner.toBase58(),
      data: [row.data.toString('base64'), 'base64'],
    }));
    fs.writeFileSync(stateFile, JSON.stringify({ accounts, genesis: f.policy.networkGenesis }));
    fs.writeFileSync(
      preload,
      `const fs=require('node:fs');const state=JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)},'utf8'));const open=fs.openSync,read=fs.readFileSync,close=fs.closeSync,keys=new Set();fs.openSync=function(file,...args){const fd=open.call(this,file,...args);if(file===${JSON.stringify(keyFile)})keys.add(fd);return fd;};fs.closeSync=function(fd){keys.delete(fd);return close.call(this,fd);};fs.readFileSync=function(file,...args){if(keys.has(file))fs.writeFileSync(${JSON.stringify(marker)},'true');return read.call(this,file,...args);};global.fetch=async(url,init)=>{if(new URL(url).origin!=='https://rpc.example.test')throw Error('External network forbidden');const q=JSON.parse(init.body);let result;switch(q.method){case 'getGenesisHash':result=state.genesis;break;case 'getEpochInfo':result={absoluteSlot:100,blockHeight:100,epoch:0,slotIndex:100,slotsInEpoch:432000};break;case 'getMultipleAccounts':result={context:{slot:100},value:state.accounts};break;case 'isBlockhashValid':result={context:{slot:100},value:true};break;case 'getFeeForMessage':result={context:{slot:100},value:5000};break;default:throw Error('RPC mutation forbidden');}return new Response(JSON.stringify({jsonrpc:'2.0',id:q.id,result}),{status:200});};`
    );
    fs.appendFileSync(
      preload,
      `const readFd=fs.readSync;fs.readSync=function(fd,...args){if(keys.has(fd))fs.writeFileSync(${JSON.stringify(marker)},'true');return readFd.call(this,fd,...args);};`
    );
    async function run(request: unknown, check = false) {
      return await new Promise<{ code: number | null; out: string; err: string }>(
        (resolve, reject) => {
          const child = spawn(
              process.execPath,
              [
                '--require',
                preload,
                entry,
                '--config',
                policyFile,
                ...(check ? ['--check-config'] : []),
              ],
              {
                cwd: folder,
                windowsHide: true,
                env: {
                  PATH: path.dirname(process.execPath),
                  SystemRoot: process.env.SystemRoot,
                  WINDIR: process.env.WINDIR,
                  NODE_ENV: 'production',
                },
                stdio: ['pipe', 'pipe', 'pipe'],
              }
            ),
            timer = setTimeout(() => {
              child.kill();
              reject(Error('Fixture signer timeout'));
            }, 15000);
          let out = '',
            err = '';
          child.stdout.on('data', (part) => (out += part));
          child.stderr.on('data', (part) => (err += part));
          child.once('error', reject);
          child.once('close', (code) => {
            clearTimeout(timer);
            resolve({ code, out, err });
          });
          child.stdin.end(JSON.stringify(request) + '\n');
        }
      );
    }
    const check = await run({}, true);
    expect(check.code).toBe(0);
    expect(JSON.parse(check.out).privateKeyLoaded).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
    const invalid = f.request();
    invalid.requestId = 'a'.repeat(64);
    const denied = await run(invalid);
    expect(denied.code).toBe(1);
    expect(denied.out).toBe('');
    expect(denied.err).not.toContain(policyFile);
    expect(fs.existsSync(marker)).toBe(false);
    const signed = await run(f.request());
    expect(signed.code, signed.err).toBe(0);
    expect(fs.existsSync(marker)).toBe(true);
    const response = JSON.parse(signed.out);
    expect(response.requestId).toBe(f.request().requestId);
    expect(
      validateSignedTransaction(response.signedTransactionBase64, f.request().messageDigest)
        .signature
    ).toBe(response.signature);
    expect(signed.err).not.toContain('Restricted signer rejected');
    const throughTransport = await requestExternalSignature({
      command: {
        executable: process.execPath,
        argv: ['--require', preload, entry, '--config', policyFile],
        timeoutMs: 15000,
      },
      execution: f.request(),
      rpc: f.rpc as unknown as Connection,
    });
    expect(throughTransport.signature).toBe(response.signature);
    expect(throughTransport.requestId).toBe(f.request().requestId);
  } finally {
    if (
      path.dirname(folder) !== tempRoot ||
      !path.basename(folder).startsWith('rinsed-reference-signer-')
    )
      throw Error('Unsafe fixture cleanup path');
    fs.rmSync(folder, { recursive: true, force: true });
  }
}, 20000);

it('refuses buybacks without a fresh independently approved exact message and output floor', async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      f.policy.approvedBuybacks = [];
    },
    (f: ReturnType<typeof fixture>) => {
      f.policy.approvedBuybacks[0]!.minimumTokens = '100';
    },
    (f: ReturnType<typeof fixture>) => {
      f.policy.approvedBuybacks[0]!.expiresAt = 99;
    },
    (f: ReturnType<typeof fixture>) => {
      f.policy.approvedBuybacks[0]!.messageDigest = 'a'.repeat(64);
    },
    (f: ReturnType<typeof fixture>) => {
      f.policy.approvedBuybacks.push({ ...f.policy.approvedBuybacks[0]! });
    },
  ]) {
    const f = fixture('buyback');
    mutate(f);
    await expect(f.call()).rejects.toThrow();
  }
});

it('rejects real address lookup table transactions before any RPC read', async () => {
  const f = fixture(),
    lookup = new AddressLookupTableAccount({
      key: pub(25),
      state: {
        deactivationSlot: (1n << 64n) - 1n,
        lastExtendedSlot: 0,
        lastExtendedSlotStartIndex: 0,
        authority: undefined,
        addresses: [f.addresses.coin, f.addresses.settings],
      },
    }),
    message = new TransactionMessage({
      payerKey: f.operator.publicKey,
      recentBlockhash: f.transaction.recentBlockhash!,
      instructions: f.transaction.instructions,
    }).compileToV0Message([lookup]);
  expect(message.addressTableLookups.length).toBeGreaterThan(0);
  const tx = new VersionedTransaction(message),
    request = f.request();
  request.messageDigest = messageDigest(message.serialize());
  request.transactionBase64 = Buffer.from(tx.serialize()).toString('base64');
  request.requestId = signRequestId(request);
  await expect(f.call(request)).rejects.toThrow();
  expect(f.rpc.getGenesisHash).not.toHaveBeenCalled();
});
it('refuses buying before RINSE ends or after the approved buyback deadline', async () => {
  for (const now of [10n, 121n]) {
    const f = fixture('buyback');
    f.clock.writeBigInt64LE(now, 32);
    await expect(f.call()).rejects.toThrow();
  }
});
