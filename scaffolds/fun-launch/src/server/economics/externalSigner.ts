import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { PublicKey, VersionedTransaction, type Connection } from '@solana/web3.js';
import { messageDigest, validateSignedTransaction } from './chainEvidence';

const PURPOSE = 'rinsed-financial-sign-only' as const;
const MAX_INPUT = 8192,
  MAX_OUTPUT = 16384,
  MAX_ERROR = 4096;
const messages = {
  SIGNER_CONFIGURATION_INVALID:
    'External signer configuration is invalid. Review the private executable/argv settings.',
  SIGNER_REQUEST_INVALID: 'External signer request does not match the durable unsigned execution.',
  SIGNER_PROCESS_FAILED: 'External signer process failed. Its private output was withheld.',
  SIGNER_TIMEOUT:
    'External signer timed out. Keep the original execution and reconcile before retrying.',
  SIGNER_OUTPUT_LIMIT: 'External signer exceeded its bounded output limit. Output was withheld.',
  SIGNER_RESPONSE_INVALID:
    'External signer response did not verify against the exact prepared execution.',
  SIGNER_NETWORK_CHANGED:
    'External signer network verification failed. Nothing was persisted or broadcast.',
  SIGNER_PLAN_EXPIRED:
    'The unsigned execution expired before signing. Use positive-proof recovery.',
  SIGNER_CANCELLED: 'External signing was cancelled. Keep and reconcile the original execution.',
} as const;
export class ExternalSignerError extends Error {
  override readonly name = 'ExternalSignerError';
  constructor(readonly code: keyof typeof messages) {
    super(messages[code]);
  }
}
export type ExternalSignerCommand = {
  executable: string;
  argv: readonly string[];
  timeoutMs: number;
};
export type ExternalSignerExecution = {
  networkGenesis: string;
  vaultProgramId: string;
  executionId: string;
  executionKind: 'setup' | 'funding' | 'epoch' | 'buyback' | 'platform_claim';
  mint: string;
  messageDigest: string;
  lastValidBlockHeight: number;
  transactionBase64: string;
  feePayer: string;
  requiredSigners: readonly string[];
};
export type ExternalSignerRequest = ExternalSignerExecution & {
  version: 1;
  purpose: typeof PURPOSE;
  requestId: string;
};
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const pub = (value: string) =>
  typeof value === 'string' &&
  value.length >= 32 &&
  value.length <= 44 &&
  new PublicKey(value).toBase58() === value;
function normalizedCommand(value: unknown): ExternalSignerCommand {
  try {
    if (
      !object(value) ||
      Object.keys(value).some((key) => !['executable', 'argv', 'timeoutMs'].includes(key)) ||
      typeof value.executable !== 'string' ||
      !path.isAbsolute(value.executable) ||
      value.executable.length > 4096 ||
      value.executable.includes('\0') ||
      !fs.statSync(value.executable).isFile() ||
      /\.(cmd|bat|ps1)$/i.test(value.executable) ||
      !Array.isArray(value.argv) ||
      value.argv.length > 32 ||
      value.argv.some(
        (arg) => typeof arg !== 'string' || arg.includes('\0') || Buffer.byteLength(arg) > 1024
      ) ||
      Buffer.byteLength(JSON.stringify(value.argv)) > 8192 ||
      !Number.isSafeInteger(value.timeoutMs) ||
      Number(value.timeoutMs) < 100 ||
      Number(value.timeoutMs) > 120000
    )
      throw new Error();
    return Object.freeze({
      executable: value.executable,
      argv: Object.freeze([...value.argv] as string[]),
      timeoutMs: Number(value.timeoutMs),
    });
  } catch {
    throw new ExternalSignerError('SIGNER_CONFIGURATION_INVALID');
  }
}
/** Public executable/argv references only. The worker never reads a signing-key/provider credential file. */
export function loadExternalSignerCommand(input: {
  command?: string;
  configFile?: string;
}): ExternalSignerCommand {
  if (!!input.command === !!input.configFile)
    throw new ExternalSignerError('SIGNER_CONFIGURATION_INVALID');
  if (input.command)
    return normalizedCommand({ executable: input.command, argv: [], timeoutMs: 30000 });
  let descriptor: number | undefined;
  try {
    const file = input.configFile!;
    if (!path.isAbsolute(file)) throw new Error();
    const before = fs.lstatSync(file);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size > 8192 ||
      (process.platform !== 'win32' &&
        ((before.mode & 0o077) !== 0 || before.uid !== process.getuid?.()))
    )
      throw new Error();
    descriptor = fs.openSync(
      file,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)
    );
    const actual = fs.fstatSync(descriptor);
    if (
      actual.dev !== before.dev ||
      actual.ino !== before.ino ||
      !actual.isFile() ||
      actual.size > 8192 ||
      (process.platform !== 'win32' &&
        ((actual.mode & 0o077) !== 0 || actual.uid !== process.getuid?.()))
    )
      throw new Error();
    const buffer = Buffer.alloc(8193);
    let value: unknown,
      length = 0;
    try {
      while (length < buffer.length) {
        const received = fs.readSync(descriptor, buffer, length, buffer.length - length, null);
        if (received === 0) break;
        length += received;
      }
      if (length > 8192) throw new Error();
      value = JSON.parse(buffer.subarray(0, length).toString('utf8'));
    } finally {
      buffer.fill(0);
    }
    if (
      !object(value) ||
      value.version !== 1 ||
      Object.keys(value).some(
        (key) => !['version', 'executable', 'argv', 'timeoutMs'].includes(key)
      )
    )
      throw new Error();
    return normalizedCommand({
      executable: value.executable,
      argv: value.argv ?? [],
      timeoutMs: value.timeoutMs ?? 30000,
    });
  } catch {
    throw new ExternalSignerError('SIGNER_CONFIGURATION_INVALID');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}
export function externalSignerRequest(input: ExternalSignerExecution): ExternalSignerRequest {
  try {
    if (
      !['setup', 'funding', 'epoch', 'buyback', 'platform_claim'].includes(input.executionKind) ||
      !/^[a-f0-9]{64}$/.test(input.messageDigest) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.executionId) ||
      ![input.networkGenesis, input.vaultProgramId, input.mint, input.feePayer].every(pub) ||
      !Number.isSafeInteger(input.lastValidBlockHeight) ||
      input.lastValidBlockHeight < 0 ||
      !Array.isArray(input.requiredSigners) ||
      input.requiredSigners.length < 1 ||
      input.requiredSigners.length > 8 ||
      !input.requiredSigners.every(pub) ||
      new Set(input.requiredSigners).size !== input.requiredSigners.length ||
      typeof input.transactionBase64 !== 'string' ||
      input.transactionBase64.length > 1644
    )
      throw new Error();
    const bytes = Buffer.from(input.transactionBase64, 'base64'),
      tx = VersionedTransaction.deserialize(bytes),
      message = tx.message.serialize();
    const signers = tx.message.staticAccountKeys
      .slice(0, tx.message.header.numRequiredSignatures)
      .map((key) => key.toBase58());
    if (
      bytes.length > 1232 ||
      bytes.toString('base64') !== input.transactionBase64 ||
      messageDigest(message) !== input.messageDigest ||
      signers[0] !== input.feePayer ||
      JSON.stringify(signers) !== JSON.stringify(input.requiredSigners) ||
      tx.signatures.some((signature) => signature.some((byte) => byte !== 0))
    )
      throw new Error();
    const requestId = createHash('sha256')
      .update(
        JSON.stringify([
          'rinsed-external-signer-v1',
          input.networkGenesis,
          input.vaultProgramId,
          input.executionId,
          input.executionKind,
          input.mint,
          input.messageDigest,
          input.feePayer,
          input.requiredSigners,
          input.lastValidBlockHeight,
        ])
      )
      .digest('hex');
    const request = {
      version: 1 as const,
      purpose: PURPOSE,
      requestId,
      networkGenesis: input.networkGenesis,
      vaultProgramId: input.vaultProgramId,
      executionId: input.executionId,
      executionKind: input.executionKind,
      mint: input.mint,
      messageDigest: input.messageDigest,
      feePayer: input.feePayer,
      requiredSigners: [...input.requiredSigners],
      lastValidBlockHeight: input.lastValidBlockHeight,
      transactionBase64: input.transactionBase64,
    };
    if (Buffer.byteLength(JSON.stringify(request) + '\n') > MAX_INPUT) throw new Error();
    return request;
  } catch {
    throw new ExternalSignerError('SIGNER_REQUEST_INVALID');
  }
}
function minimalEnvironment(): NodeJS.ProcessEnv {
  // No database/admin/checkpoint/RPC secrets, NODE_OPTIONS or inherited signer key variables.
  const result: NodeJS.ProcessEnv = { NODE_ENV: 'production' };
  for (const name of [
    'PATH',
    'Path',
    'SystemRoot',
    'SYSTEMROOT',
    'WINDIR',
    'PATHEXT',
    'HOME',
    'USERPROFILE',
    'LOCALAPPDATA',
    'APPDATA',
    'TMP',
    'TEMP',
    'TMPDIR',
  ])
    if (process.env[name] !== undefined) result[name] = process.env[name];
  return result;
}
export function signerExchange(
  command: ExternalSignerCommand,
  request: unknown,
  signal?: AbortSignal
): Promise<unknown> {
  if (Buffer.byteLength(JSON.stringify(request) + '\n') > MAX_INPUT)
    throw new ExternalSignerError('SIGNER_REQUEST_INVALID');
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ExternalSignerError('SIGNER_CANCELLED'));
    const child = spawn(command.executable, [...command.argv], {
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      cwd: path.dirname(command.executable),
      env: minimalEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdoutBytes = 0,
      stderrBytes = 0,
      settled = false;
    const stdout: Buffer[] = [];
    const kill = () => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        /* Child may already be gone. */
      }
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const finish = (error?: ExternalSignerError, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) {
        kill();
        reject(error);
      } else resolve(value);
    };
    const abort = () => finish(new ExternalSignerError('SIGNER_CANCELLED')),
      timer = setTimeout(
        () => finish(new ExternalSignerError('SIGNER_TIMEOUT')),
        command.timeoutMs
      );
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.on('error', () => finish(new ExternalSignerError('SIGNER_PROCESS_FAILED')));
    child.stdin.on('error', () => finish(new ExternalSignerError('SIGNER_PROCESS_FAILED')));
    child.stdout.on('data', (bytes: Buffer) => {
      stdoutBytes += bytes.length;
      if (stdoutBytes > MAX_OUTPUT) finish(new ExternalSignerError('SIGNER_OUTPUT_LIMIT'));
      else stdout.push(bytes);
    });
    child.stderr.on('data', (bytes: Buffer) => {
      stderrBytes += bytes.length;
      if (stderrBytes > MAX_ERROR) finish(new ExternalSignerError('SIGNER_OUTPUT_LIMIT'));
    });
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) return finish(new ExternalSignerError('SIGNER_PROCESS_FAILED'));
      try {
        finish(undefined, JSON.parse(Buffer.concat(stdout).toString('utf8')));
      } catch {
        finish(new ExternalSignerError('SIGNER_RESPONSE_INVALID'));
      }
    });
    child.stdin.end(JSON.stringify(request) + '\n');
  });
}
async function boundedRpc<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ExternalSignerError('SIGNER_NETWORK_CHANGED')), 15000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export async function requestExternalSignature(input: {
  command: ExternalSignerCommand;
  execution: ExternalSignerExecution;
  rpc: Pick<Connection, 'getGenesisHash' | 'getEpochInfo'>;
  signal?: AbortSignal;
}) {
  const command = normalizedCommand(input.command),
    request = externalSignerRequest(input.execution);
  try {
    if (input.signal?.aborted) throw new ExternalSignerError('SIGNER_CANCELLED');
    if ((await boundedRpc(input.rpc.getGenesisHash())) !== request.networkGenesis)
      throw new ExternalSignerError('SIGNER_NETWORK_CHANGED');
    const bank = await boundedRpc(input.rpc.getEpochInfo({ commitment: 'finalized' }));
    if (
      !Number.isSafeInteger(bank.blockHeight) ||
      typeof bank.blockHeight !== 'number' ||
      bank.blockHeight < 0
    )
      throw new ExternalSignerError('SIGNER_NETWORK_CHANGED');
    if (bank.blockHeight > request.lastValidBlockHeight)
      throw new ExternalSignerError('SIGNER_PLAN_EXPIRED');
    const result = await signerExchange(command, request, input.signal);
    const fields = [
      'version',
      'purpose',
      'requestId',
      'networkGenesis',
      'vaultProgramId',
      'executionId',
      'messageDigest',
      'feePayer',
      'requiredSigners',
      'signedTransactionBase64',
      'signature',
    ];
    if (
      !object(result) ||
      Object.keys(result).some((key) => !fields.includes(key)) ||
      fields.some((key) => !(key in result)) ||
      result.version !== 1 ||
      result.purpose !== PURPOSE ||
      ![
        'requestId',
        'networkGenesis',
        'vaultProgramId',
        'executionId',
        'messageDigest',
        'feePayer',
      ].every((key) => result[key] === request[key as keyof ExternalSignerRequest]) ||
      JSON.stringify(result.requiredSigners) !== JSON.stringify(request.requiredSigners) ||
      typeof result.signedTransactionBase64 !== 'string' ||
      typeof result.signature !== 'string'
    )
      throw new ExternalSignerError('SIGNER_RESPONSE_INVALID');
    let signed: ReturnType<typeof validateSignedTransaction>;
    try {
      signed = validateSignedTransaction(result.signedTransactionBase64, request.messageDigest);
    } catch {
      throw new ExternalSignerError('SIGNER_RESPONSE_INVALID');
    }
    if (signed.signature !== result.signature)
      throw new ExternalSignerError('SIGNER_RESPONSE_INVALID');
    const after = await boundedRpc(input.rpc.getEpochInfo({ commitment: 'finalized' }));
    if (
      typeof after.blockHeight !== 'number' ||
      !Number.isSafeInteger(after.blockHeight) ||
      after.blockHeight < 0
    )
      throw new ExternalSignerError('SIGNER_NETWORK_CHANGED');
    if (after.blockHeight > request.lastValidBlockHeight)
      throw new ExternalSignerError('SIGNER_PLAN_EXPIRED');
    if ((await boundedRpc(input.rpc.getGenesisHash())) !== request.networkGenesis)
      throw new ExternalSignerError('SIGNER_NETWORK_CHANGED');
    if (input.signal?.aborted) throw new ExternalSignerError('SIGNER_CANCELLED');
    return {
      signedTransactionBase64: result.signedTransactionBase64,
      signature: signed.signature,
      requestId: request.requestId,
    };
  } catch (error) {
    if (error instanceof ExternalSignerError) throw error;
    throw new ExternalSignerError('SIGNER_NETWORK_CHANGED');
  }
}
