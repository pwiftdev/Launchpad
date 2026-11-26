import { createSprClient, SOL_MINT, ShieldedKeypair, SigningKey } from '@heliuslabs/spr';
import { getSplAssetRegistryAddress } from '@heliuslabs/spr/addresses';
import { atSlot } from '@heliuslabs/spr/client';
import {
  decodeSplAssetRegistry,
  transactInstruction,
  TransactWithdrawal,
} from '@heliuslabs/spr/interface';
import { bytes32 } from '@heliuslabs/spr/keypair';
import {
  AssetRegistry,
  ConfidentialTransfer,
  decryptToBalances,
  ProofInputUtxo,
  WithdrawalTarget,
} from '@heliuslabs/spr/transaction';
import { buildDepositTransaction } from '@heliuslabs/spr/wallet';
import {
  address,
  appendTransactionMessageInstruction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageConfig,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  signTransactionWithSigners,
  type Address,
  type Transaction,
} from '@solana/kit';
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token';
import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { expect, it } from 'vitest';
import { NETWORK_GENESIS } from '../../../../scripts/network-policy.cjs';
import {
  combineRingsSwapSignatures,
  proveRingsSwapLeg,
  signRingsSwap,
  type RingsSwap,
} from './otcRingsSettlement';

const rpc = 'http://127.0.0.1:19899';
const solAmount = 10_000_000n;
const tokenAmount = 20_000n;

it.runIf(process.env.OTC_RINGS_LOCALNET === '1')(
  'settles both shielded legs together on the local validator',
  async () => {
    const connection = new Connection(rpc, 'confirmed');
    expect(Object.values(NETWORK_GENESIS)).not.toContain(await connection.getGenesisHash());
    const identities = [Keypair.generate(), Keypair.generate()] as const;
    const [maker, taker] = identities.map((key) => {
      const seed = key.secretKey.slice(0, 32);
      try {
        return ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(bytes32(seed)));
      } finally {
        seed.fill(0);
      }
    }) as [ShieldedKeypair, ShieldedKeypair];
    const client = await createSprClient({
      solanaRpcUrl: rpc,
      indexerUrl: 'http://127.0.0.1:19784',
      proverUrl: 'http://127.0.0.1:19301',
      commitment: 'confirmed',
    });

    async function send(transaction: Transaction, skipPreflight = false) {
      const signature = await client.solanaRpc
        .sendTransaction(getBase64EncodedWireTransaction(transaction), {
          encoding: 'base64',
          preflightCommitment: 'confirmed',
          skipPreflight,
        })
        .send();
      const slot = await client.confirmTransaction(signature);
      const result = await client.getShieldedTransactionsBySignature(signature, atSlot(slot));
      return result.transactions.map((entry) => entry.transaction);
    }

    async function fund(wallet: ShieldedKeypair, asset: Address, amount: bigint) {
      const signer = wallet.toSolanaSigner();
      const deposit = await buildDepositTransaction({
        client,
        feePayer: signer.address,
        recipient: wallet.shieldedAddress(),
        asset,
        amount,
      });
      return send(await signTransactionWithSigners([signer], deposit));
    }

    async function verifyAbandonedFundingCanBeWithdrawn(assets: AssetRegistry) {
      const transactions = await fund(maker, SOL_MINT, solAmount);
      const balance = await decryptToBalances({ keypair: maker, registry: assets, transactions });
      const [note] = balance.balance(SOL_MINT).utxos;
      if (!note) throw new Error('The abandoned deal funding was not indexed.');
      const signer = maker.toSolanaSigner();
      const target = { recipient: signer.address };
      const transfer = ConfidentialTransfer.compact(
        maker.shieldedAddress(),
        [ProofInputUtxo.fromKeypair(note, maker)],
        signer.address
      );
      transfer.withdraw(SOL_MINT, solAmount, WithdrawalTarget.sol(target));
      const data = await client.proveTransact(transfer.sign(maker, assets), [maker]);
      const instruction = await transactInstruction({
        payer: signer,
        ownerSigners: [signer],
        inputTree: client.tree,
        outputTree: client.tree,
        withdrawal: TransactWithdrawal.sol(target),
        data,
      });
      const lifetime = await client.getLatestBlockhash();
      const before = await client.getBalance(signer.address);
      const transaction = await signTransactionMessageWithSigners(
        pipe(
          createTransactionMessage({ version: 1 }),
          (message) => setTransactionMessageFeePayerSigner(signer, message),
          (message) => setTransactionMessageLifetimeUsingBlockhash(lifetime, message),
          (message) =>
            setTransactionMessageConfig(
              { computeUnitLimit: 450_000, loadedAccountsDataSizeLimit: 64 * 1024 * 1024 },
              message
            ),
          (message) => appendTransactionMessageInstruction(instruction, message)
        )
      );
      await send(transaction);
      expect(await client.getBalance(signer.address)).toBeGreaterThan(before);
    }

    try {
      for (const key of identities) {
        const signature = await connection.requestAirdrop(key.publicKey, 2 * LAMPORTS_PER_SOL);
        await connection.confirmTransaction(signature, 'confirmed');
      }
      const buyer = identities[1];
      const mint = await createMint(connection, buyer, buyer.publicKey, null, 6);
      const tokenAccount = await getOrCreateAssociatedTokenAccount(
        connection,
        buyer,
        mint,
        buyer.publicKey
      );
      await mintTo(connection, buyer, mint, tokenAccount.address, buyer, tokenAmount);
      const token = address(mint.toBase58());
      const makerDeposit = await fund(maker, SOL_MINT, solAmount);
      const takerDeposit = await fund(taker, token, tokenAmount);

      const registry = await client.getAccount(await getSplAssetRegistryAddress(token));
      if (!registry) throw new Error('Local test mint has no shielded asset registration.');
      const { assetId, mint: registryMint } = decodeSplAssetRegistry(registry.data);
      const assets = new AssetRegistry([[assetId, registryMint]]);
      const makerBalance = await decryptToBalances({
        keypair: maker,
        registry: assets,
        transactions: makerDeposit,
      });
      const takerBalance = await decryptToBalances({
        keypair: taker,
        registry: assets,
        transactions: takerDeposit,
      });
      const [solNote] = makerBalance.balance(SOL_MINT).utxos;
      const [tokenNote] = takerBalance.balance(token).utxos;
      if (!solNote || !tokenNote)
        throw new Error('The indexer did not find both local funding notes.');

      const swap: RingsSwap = {
        maker: { owner: maker.shieldedAddress(), asset: SOL_MINT, amount: solAmount },
        taker: { owner: taker.shieldedAddress(), asset: token, amount: tokenAmount },
        expiresAt: BigInt(Math.floor(Date.now() / 1000) + 600),
      };
      const makerFunding = ProofInputUtxo.fromKeypair(solNote, maker);
      const takerFunding = ProofInputUtxo.fromKeypair(tokenNote, taker);
      const makerProof = await proveRingsSwapLeg({
        swap,
        side: 'maker',
        wallet: maker,
        funding: makerFunding,
        assets,
        client,
      });
      const takerProof = await proveRingsSwapLeg({
        swap,
        side: 'taker',
        wallet: taker,
        funding: takerFunding,
        assets,
        client,
      });
      const lifetime = await client.getLatestBlockhash();
      const makerRequest = {
        swap,
        side: 'maker' as const,
        wallet: maker,
        funding: makerFunding,
        outgoing: makerProof,
        incoming: takerProof,
        assets,
        lifetime,
      };
      const takerRequest = {
        swap,
        side: 'taker' as const,
        wallet: taker,
        funding: takerFunding,
        outgoing: takerProof,
        incoming: makerProof,
        assets,
        lifetime,
      };
      await expect(
        signRingsSwap({
          ...makerRequest,
          swap: { ...swap, taker: { ...swap.taker, amount: tokenAmount + 1n } },
        })
      ).rejects.toThrow('agreed asset and amount');
      await expect(
        signRingsSwap({ ...makerRequest, swap: { ...swap, expiresAt: 1n } })
      ).rejects.toThrow('offer expired');
      const [makerInput] = makerProof.inputs;
      await expect(
        signRingsSwap({
          ...makerRequest,
          outgoing: {
            ...makerProof,
            inputs: [{ ...makerInput!, nullifierHash: bytes32(new Uint8Array(32)) }],
          },
        })
      ).rejects.toThrow('different funding note');
      const [recipientOutput] = takerProof.outputs;
      await expect(
        signRingsSwap({
          ...makerRequest,
          incoming: {
            ...takerProof,
            outputs: [{ ...recipientOutput!, utxoHash: bytes32(new Uint8Array(32)) }],
          },
        })
      ).rejects.toThrow('agreed asset and amount');
      const makerSigned = await signRingsSwap(makerRequest);
      await expect(send(makerSigned)).rejects.toThrow();
      const takerSigned = await signRingsSwap(takerRequest);
      const badProof = {
        ...takerProof,
        proof: { ...takerProof.proof, a: bytes32(new Uint8Array(32)) },
      };
      const failedMaker = await signRingsSwap({ ...makerRequest, incoming: badProof });
      const failedTaker = await signRingsSwap({ ...takerRequest, outgoing: badProof });
      const failedTransaction = await combineRingsSwapSignatures(swap, failedMaker, failedTaker);
      await expect(send(failedTransaction, true)).rejects.toThrow();
      const failedRecord = await client.solanaRpc
        .getTransaction(getSignatureFromTransaction(failedTransaction), {
          commitment: 'confirmed',
          encoding: 'json',
          maxSupportedTransactionVersion: 1,
        })
        .send();
      expect(failedRecord?.meta?.err).toMatchObject({
        InstructionError: [1n, expect.anything()],
      });
      const settled = await send(await combineRingsSwapSignatures(swap, makerSigned, takerSigned));
      const makerReceived = await decryptToBalances({
        keypair: maker,
        registry: assets,
        transactions: settled,
      });
      const takerReceived = await decryptToBalances({
        keypair: taker,
        registry: assets,
        transactions: settled,
      });
      expect(makerReceived.balance(token).amount).toBe(tokenAmount);
      expect(takerReceived.balance(SOL_MINT).amount).toBe(solAmount);

      const refreshed = await client.getLatestBlockhash();
      const retry = await signRingsSwap({ ...makerRequest, lifetime: refreshed });
      const retryTaker = await signRingsSwap({ ...takerRequest, lifetime: refreshed });
      await expect(combineRingsSwapSignatures(swap, makerSigned, retryTaker)).rejects.toThrow(
        'different settlement transactions'
      );
      await expect(
        send(await combineRingsSwapSignatures(swap, retry, retryTaker))
      ).rejects.toThrow();
      await verifyAbandonedFundingCanBeWithdrawn(assets);
    } finally {
      maker.destroy();
      taker.destroy();
    }
  },
  120_000
);
