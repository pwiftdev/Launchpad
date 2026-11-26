import {
  createSprClient,
  SHIELDED_POOL_PROGRAM_ID,
  SOL_MINT,
  type Address,
  type ShieldedKeypair,
} from '@heliuslabs/spr';
import { getProtocolConfigAddress, getSplAssetRegistryAddress } from '@heliuslabs/spr/addresses';
import { atSlot, SignedTeePolicy } from '@heliuslabs/spr/client';
import {
  checkedTransactionSize,
  decodeProtocolConfig,
  decodeSplAssetRegistry,
  transactInstruction,
  TransactWithdrawal,
} from '@heliuslabs/spr/interface';
import {
  AssetRegistry,
  ConfidentialTransfer,
  decryptToBalances,
  ProofInputUtxo,
  WithdrawalTarget,
} from '@heliuslabs/spr/transaction';
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageConfig,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signature,
  signTransactionWithSigners,
  type Transaction,
  type TransactionMessageBytesBase64,
} from '@solana/kit';
import { createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { NETWORK_GENESIS } from '../../../../scripts/network-policy.cjs';
import { OTC_WALLET_HEADER } from './otc';
import {
  dealLeg,
  dealTermsLeg,
  ringsLegMint,
  ringsTokenAccount,
  ringsTokenProgram,
} from './otcRingsDeposit';
import { ringsBase64, ringsBytes } from './otcRingsPackets';
import { OTC_RINGS_RPC, type RingsRoom } from './otcRingsRoom';

export type RingsClient = Awaited<ReturnType<typeof createSprClient>>;

export async function connectRingsRoom(room: RingsRoom, wallet: string, signal: AbortSignal) {
  const network =
    room.genesis === NETWORK_GENESIS['mainnet-beta']
      ? 'mainnet'
      : room.genesis === NETWORK_GENESIS.devnet
        ? 'devnet'
        : null;
  const origin = network ? `https://${network}.helius-rpc.com` : 'http://127.0.0.1:19899';
  const client = await createSprClient({
    solanaRpcUrl: origin,
    indexerUrl: `${origin}/v1/spr`,
    proverUrl: `${origin}/v1/spr`,
    proverTee: network ? SignedTeePolicy.forNetwork(network) : undefined,
    proverAsyncPoll: { pollIntervalCapMs: 1000, maxWaitMs: 40_000 },
    commitment: 'confirmed',
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const headers = Object.fromEntries(
        [...new Headers(init?.headers)].filter(
          ([name]) =>
            ['content-type', 'x-sync', 'x-async'].includes(name) || name.startsWith('spr-tee')
        )
      );
      const body = init?.body;
      if (url.origin !== origin) {
        if (
          !network ||
          url.href !== `https://d3gbdb0egjwcw9.cloudfront.net/tee-policy/${network}.json`
        )
          throw new Error('Invalid Rings destination.');
        return fetch(url, { ...init, credentials: 'omit', redirect: 'error' });
      }
      const requestSignal = init?.signal ? AbortSignal.any([signal, init.signal]) : signal;
      return fetch(OTC_RINGS_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [OTC_WALLET_HEADER]: wallet },
        body: JSON.stringify({
          id: room.id,
          path: url.pathname,
          search: url.search,
          method: init?.method ?? 'GET',
          headers,
          ...(typeof body === 'string'
            ? { body }
            : ArrayBuffer.isView(body)
              ? { body: ringsBase64(new Uint8Array(body.buffer, body.byteOffset, body.byteLength)) }
              : {}),
        }),
        signal: requestSignal,
        redirect: 'error',
      });
    },
  });
  if ((await client.solanaRpc.getGenesisHash().send({ abortSignal: signal })) !== room.genesis)
    throw new Error('The Rings connection is on the wrong Solana network.');
  return client;
}

async function registryEntry(client: RingsClient, mint: Address) {
  const { value: registry } = await client.solanaRpc
    .getAccountInfo(await getSplAssetRegistryAddress(mint), {
      commitment: 'finalized',
      encoding: 'base64',
    })
    .send();
  if (!registry?.data[0]) return null;
  if (registry.owner !== SHIELDED_POOL_PROGRAM_ID)
    throw new Error('The Rings asset registry is unavailable.');
  const info = decodeSplAssetRegistry(ringsBytes(registry.data[0]));
  if (info.mint !== mint) throw new Error('The Rings registry entry does not match the deal.');
  return info;
}

const dealMints = (room: RingsRoom) =>
  [...new Set([room.terms.sell, room.terms.buy].map((leg) => ringsLegMint(leg, room)))].filter(
    (mint) => mint !== SOL_MINT
  );

export async function ringsAssets(client: RingsClient, room: RingsRoom) {
  return new AssetRegistry(
    await Promise.all(
      dealMints(room).map(async (mint) => {
        const registry = await registryEntry(client, mint);
        if (!registry) throw new Error('A token in this deal still needs Rings setup.');
        return [registry.assetId, mint] as const;
      })
    )
  );
}

export async function checkRingsFundingAccess(client: RingsClient, room: RingsRoom) {
  const mints = dealMints(room);
  const entries = await Promise.all(mints.map((mint) => registryEntry(client, mint)));
  const missing = mints.filter((_, index) => !entries[index]);
  const own = dealTermsLeg(room.terms, room.side);
  if (missing.length) {
    if (
      missing.length === 1 &&
      [room.terms.sell, room.terms.buy].some(
        (leg) => leg.asset === 'TOKEN' && leg.token.mint === missing[0]
      ) &&
      own.asset !== 'TOKEN'
    )
      throw new Error('Wait for the launch token holder to fund first and complete Rings setup.');
    if (missing.length !== 1 || own.asset !== 'TOKEN' || own.token.mint !== missing[0])
      throw new Error('A quote asset is unavailable in Helius Rings.');
    const config = await client.getAccount(await getProtocolConfigAddress());
    if (
      config?.owner !== SHIELDED_POOL_PROGRAM_ID ||
      !decodeProtocolConfig(config.data).splInterfaceCreationIsPermissionless
    )
      throw new Error('This token still needs setup in Helius Rings.');
  }
  if (Object.values(NETWORK_GENESIS).includes(room.genesis)) await client.attestProver();
  return missing.length === 1;
}

export async function ringsStatus(client: RingsClient, tx: string) {
  return (await ringsStatuses(client, [tx]))[0] ?? null;
}

export async function ringsStatuses(client: RingsClient, txs: string[], signal?: AbortSignal) {
  if (!txs.length) return [];
  const response = await client.solanaRpc
    .getSignatureStatuses(txs.map(signature), { searchTransactionHistory: true })
    .send({ abortSignal: signal });
  return response.value;
}

export async function publishRingsTransaction(
  client: RingsClient,
  encoded: string,
  expected: string
) {
  const status = await ringsStatus(client, expected);
  if (status?.err)
    throw new Error('Solana rejected this transaction. Check its status before trying again.');
  if (!status) {
    try {
      const submitted = await client.solanaRpc
        .sendTransaction(encoded as ReturnType<typeof getBase64EncodedWireTransaction>, {
          encoding: 'base64',
          preflightCommitment: 'confirmed',
        })
        .send();
      if (submitted !== expected) throw new Error('The transaction receipt did not match.');
    } catch {
      if (!(await ringsStatus(client, expected)))
        throw new Error(
          'Submission could not be confirmed. Refresh or resend the same transaction.'
        );
    }
  }
  const result = await ringsStatus(client, expected);
  if (result?.err)
    throw new Error('Solana rejected this transaction. Check its status before trying again.');
  return expected;
}

export async function readRingsNote(
  client: RingsClient,
  tx: string,
  wallet: ShieldedKeypair,
  asset: Address,
  amount: bigint,
  assets: AssetRegistry
) {
  const status = await ringsStatus(client, tx);
  if (!status || status.err || status.confirmationStatus !== 'finalized')
    throw new Error('Wait for Solana to finalize the transaction.');
  const indexed = await client.getShieldedTransactionsBySignature(
    signature(tx),
    atSlot(status.slot)
  );
  const balances = await decryptToBalances({
    keypair: wallet,
    registry: assets,
    transactions: indexed.transactions.map((entry) => entry.transaction),
  });
  const matches = balances.balance(asset).utxos.filter((note) => note.amount === amount);
  if (matches.length !== 1) throw new Error('The exact private amount could not be verified.');
  return ProofInputUtxo.fromKeypair(matches[0]!, wallet);
}

export async function ownRingsFunding(
  client: RingsClient,
  room: RingsRoom,
  wallet: ShieldedKeypair,
  assets: AssetRegistry
) {
  const own = room[room.side].funding;
  if (!own) throw new Error('Fund your side of the deal first.');
  const { asset, amount } = dealLeg(room, room.side);
  return readRingsNote(client, own.signature, wallet, asset, amount, assets);
}

type Lifetime = Awaited<ReturnType<RingsClient['getLatestBlockhash']>>;
function buildPrivateTransaction(
  payer: Address,
  lifetime: Lifetime,
  instructions: Parameters<typeof appendTransactionMessageInstructions>[0]
) {
  return checkedTransactionSize(
    pipe(
      createTransactionMessage({ version: 1 }),
      (message) => setTransactionMessageFeePayer(payer, message),
      (message) => setTransactionMessageLifetimeUsingBlockhash(lifetime, message),
      (message) =>
        setTransactionMessageConfig(
          { computeUnitLimit: 450_000, loadedAccountsDataSizeLimit: 64 * 1024 * 1024 },
          message
        ),
      (message) => appendTransactionMessageInstructions(instructions, message),
      compileTransaction
    )
  );
}

async function signPrivatePacket(
  wallet: ShieldedKeypair,
  lifetime: Lifetime,
  transaction: Transaction
) {
  return {
    ...wireRingsTransaction(
      await signTransactionWithSigners([wallet.toSolanaSigner()], transaction)
    ),
    blockhash: lifetime.blockhash,
    lastValidBlockHeight: String(lifetime.lastValidBlockHeight),
  };
}

export async function withdrawRingsNote(
  client: RingsClient,
  wallet: ShieldedKeypair,
  note: ProofInputUtxo,
  assets: AssetRegistry,
  recipient: Address,
  tokenProgram = ringsTokenProgram
) {
  const payer = wallet.toSolanaSigner().address;
  const { asset, amount } = note.utxo;
  const tokenAccount = ringsTokenAccount(asset, recipient, tokenProgram);
  const spl =
    asset === SOL_MINT
      ? null
      : await getProgramDerivedAddress({
          programAddress: SHIELDED_POOL_PROGRAM_ID,
          seeds: ['spl_asset_vault', getAddressEncoder().encode(asset)],
        });
  const target = spl
    ? WithdrawalTarget.spl({
        recipientTokenAccount: tokenAccount,
        splTokenInterface: spl[0],
        splInterfaceBump: spl[1],
      })
    : WithdrawalTarget.sol({ recipient });
  const accounts = spl
    ? TransactWithdrawal.spl({
        mint: asset,
        recipientTokenAccount: tokenAccount,
        splTokenInterface: spl[0],
        tokenProgram,
      })
    : TransactWithdrawal.sol({ recipient });
  const transfer = ConfidentialTransfer.compact(wallet.shieldedAddress(), [note], payer);
  transfer.withdraw(asset, amount, target);
  const proof = await client.proveTransact(transfer.sign(wallet, assets), [wallet]);
  const instruction = await transactInstruction({
    payer,
    ownerSigners: [payer],
    inputTree: client.tree,
    outputTree: client.tree,
    withdrawal: accounts,
    data: proof,
  });
  const setup = spl
    ? [
        createAssociatedTokenAccountIdempotentInstruction(
          new PublicKey(payer),
          new PublicKey(tokenAccount),
          new PublicKey(recipient),
          new PublicKey(asset),
          new PublicKey(tokenProgram)
        ),
      ].map(asRingsInstruction)
    : [];
  const lifetime = await client.getLatestBlockhash();
  return signPrivatePacket(
    wallet,
    lifetime,
    buildPrivateTransaction(payer, lifetime, [...setup, instruction])
  );
}

export async function returnRingsReserve(
  client: RingsClient,
  wallet: ShieldedKeypair,
  recipient: Address
) {
  const payer = wallet.toSolanaSigner().address;
  const lifetime = await client.getLatestBlockhash();
  const build = (lamports: bigint) =>
    buildPrivateTransaction(payer, lifetime, [
      asRingsInstruction(
        SystemProgram.transfer({
          fromPubkey: new PublicKey(payer),
          toPubkey: new PublicKey(recipient),
          lamports,
        })
      ),
    ]);
  const { value: balance } = await client.solanaRpc
    .getBalance(payer, { commitment: 'finalized' })
    .send();
  if (!balance) throw new Error('The deal wallet has no unused SOL.');
  const model = build(1n);
  const { value: fee } = await client.solanaRpc
    .getFeeForMessage(ringsBase64(model.messageBytes) as TransactionMessageBytesBase64)
    .send();
  if (fee === null || balance <= fee)
    throw new Error('The remaining SOL would not cover the network fee.');
  return signPrivatePacket(wallet, lifetime, build(balance - fee));
}

function asRingsInstruction(instruction: ReturnType<typeof SystemProgram.transfer>) {
  return {
    programAddress: address(instruction.programId.toBase58()),
    data: new Uint8Array(instruction.data),
    accounts: instruction.keys.map(({ pubkey, isSigner, isWritable }) => ({
      address: address(pubkey.toBase58()),
      role: ((isSigner ? 2 : 0) + (isWritable ? 1 : 0)) as AccountRole,
    })),
  };
}

export function wireRingsTransaction(transaction: Transaction) {
  return {
    transaction: getBase64EncodedWireTransaction(transaction),
    signature: getSignatureFromTransaction(transaction),
  };
}
