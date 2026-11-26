import { createSprClient, ShieldedKeypair, SigningKey } from '@heliuslabs/spr';
import { bytes32 } from '@heliuslabs/spr/keypair';
import { buildDepositTransaction } from '@heliuslabs/spr/wallet';
import {
  address,
  blockhash,
  getBase64EncodedWireTransaction,
  signTransactionWithSigners,
  type Address,
} from '@solana/kit';
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
} from '@solana/web3.js';
import { expect, vi } from 'vitest';
import {
  otcAcceptanceMessage,
  type OtcAsset,
  type OtcTokenPage,
  type OtcTerms,
  type OwnedOtcOffer,
  type ViewedOtcOffer,
} from '@/lib/otc';
import {
  connectRingsRoom,
  checkRingsFundingAccess,
  ownRingsFunding,
  publishRingsTransaction,
  readRingsNote,
  returnRingsReserve,
  ringsAssets,
  wireRingsTransaction,
  withdrawRingsNote,
} from '@/lib/otcRingsClient';
import { buildRingsDeposit, dealLeg } from '@/lib/otcRingsDeposit';
import { signRingsFunding } from '@/lib/otcRingsFunding';
import {
  decodeRingsProof,
  encodeRingsProof,
  packRingsPartial,
  ringsBase64,
  unpackRingsPartial,
} from '@/lib/otcRingsPackets';
import type { RingsRoom } from '@/lib/otcRingsRoom';
import {
  combineRingsSwapSignatures,
  proveRingsSwapLeg,
  signRingsSwap,
  type RingsSwap,
} from '@/lib/otcRingsSettlement';
import { unlockRingsDealWallet } from '@/lib/otcRingsWallet';
import type { SocialChallenge } from '@/lib/profiles';

const rpc = 'http://127.0.0.1:19899';
const origin = 'http://127.0.0.1:3000';
type Request = <T = unknown>(
  body: object,
  context?: { origin?: string; wallet?: string; cookie?: string },
  path?: string
) => Promise<{
  status: number | undefined;
  data: T;
  cookie: string | undefined;
  headers: Map<string, string>;
}>;

export async function rehearseRingsDesk(
  request: Request,
  launch?: {
    quote: OtcAsset;
    token2022: boolean;
    register: (genesis: string, mint: string) => Promise<unknown>;
  }
) {
  const connection = new Connection(rpc, 'confirmed');
  const genesis = await connection.getGenesisHash();
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', origin);
  vi.stubEnv('NEXT_PUBLIC_NETWORK', 'localnet');
  vi.stubEnv('LOCAL_VALIDATOR_ENABLED', 'true');
  vi.stubEnv('LOCAL_VALIDATOR_GENESIS_HASH', genesis);
  vi.stubEnv('RPC_URL', rpc);
  vi.stubEnv('OTC_RINGS_SETTLEMENT_ENABLED', 'true');

  const maker = Keypair.generate();
  const buyer = Keypair.generate();
  const signer = (key: Keypair) => SigningKey.fromEd25519Bytes(bytes32(key.secretKey.slice(0, 32)));
  const signers = [signer(maker), signer(buyer)] as const;
  const raw = await createSprClient({
    solanaRpcUrl: rpc,
    indexerUrl: 'http://127.0.0.1:19784',
    proverUrl: 'http://127.0.0.1:19301',
  });
  async function authorize(key: Keypair, main: SigningKey) {
    const wallet = key.publicKey.toBase58();
    const seed = await request<SocialChallenge>({ action: 'challenge', wallet }, { origin });
    expect(seed.status).toBe(200);
    const joined = await request(
      {
        action: 'join',
        wallet,
        nonce: seed.data.nonce,
        signature: ringsBase64(main.sign(new TextEncoder().encode(seed.data.message))),
      },
      { origin }
    );
    expect(joined.status).toBe(200);
    return { wallet, origin, cookie: joined.cookie };
  }

  for (const key of [maker, buyer]) {
    const tx = await connection.requestAirdrop(key.publicKey, LAMPORTS_PER_SOL);
    await connection.confirmTransaction(tx, 'confirmed');
  }
  const mint = await createMint(connection, buyer, buyer.publicKey, null, 6);
  vi.stubEnv('OTC_RINGS_LOCAL_USDC_MINT', mint.toBase58());
  const source = await getOrCreateAssociatedTokenAccount(connection, buyer, mint, buyer.publicKey);
  await mintTo(connection, buyer, mint, source.address, buyer, 100_000n);
  const payer = ShieldedKeypair.fromKeypair(signer(buyer));
  const setup = await buildDepositTransaction({
    client: raw,
    feePayer: address(buyer.publicKey.toBase58()),
    recipient: payer.shieldedAddress(),
    asset: address(mint.toBase58()),
    amount: 1n,
  });
  const init = await signTransactionWithSigners([payer.toSolanaSigner()], setup);
  const setupSig = await raw.solanaRpc
    .sendTransaction(getBase64EncodedWireTransaction(init), { encoding: 'base64' })
    .send();
  await raw.confirmTransaction(setupSig);
  payer.destroy();

  const mk = await authorize(maker, signers[0]);
  const tk = await authorize(buyer, signers[1]);
  let terms: OtcTerms = {
    sell: { asset: 'SOL', amount: '0.01' },
    buy: { asset: 'USDC', amount: '0.02' },
  };
  if (launch) {
    const tokenProgram = launch.token2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    const mint = await createMint(
      connection,
      maker,
      maker.publicKey,
      null,
      5,
      undefined,
      undefined,
      tokenProgram
    );
    const account = await getOrCreateAssociatedTokenAccount(
      connection,
      maker,
      mint,
      maker.publicKey,
      false,
      undefined,
      undefined,
      tokenProgram
    );
    await mintTo(
      connection,
      maker,
      mint,
      account.address,
      maker,
      50_000n,
      [],
      undefined,
      tokenProgram
    );
    const unknown = await request({ action: 'asset', mint: mint.toBase58() }, mk);
    expect(unknown.status).toBe(404);
    await launch.register(genesis, mint.toBase58());
    const catalog = await request<OtcTokenPage>({ action: 'assets', after: null }, mk);
    expect(catalog.status).toBe(200);
    expect(catalog.data.tokens).toContainEqual({ mint: mint.toBase58(), symbol: 'Token' });
    terms = {
      sell: {
        asset: 'TOKEN',
        amount: '0.1',
        token: {
          mint: mint.toBase58(),
          symbol: 'MSKD',
          decimals: 6,
          program: launch.token2022 ? 'spl' : 'token-2022',
        },
      },
      buy: { asset: launch.quote, amount: '0.02' },
    };
  }
  const offer = await request<{ offer: OwnedOtcOffer; token: string }>(
    {
      action: 'create',
      terms,
      minutes: 15,
      viewerWallet: tk.wallet,
    },
    mk
  );
  expect(offer.status).toBe(200);
  const { offer: owned, token } = offer.data;
  if (launch)
    expect(owned.terms.sell).toMatchObject({
      asset: 'TOKEN',
      token: { symbol: 'Token', decimals: 5, program: launch.token2022 ? 'token-2022' : 'spl' },
    });
  const message = await otcAcceptanceMessage(token, tk.wallet, origin, genesis, owned);
  const accepted = await request<ViewedOtcOffer>(
    {
      action: 'accept',
      token,
      signature: ringsBase64(signers[1].sign(new TextEncoder().encode(message))),
    },
    tk
  );
  expect(accepted.data.dealId).toBe(owned.id);
  async function act(context: typeof mk, action: string, body = {}) {
    const response = await request<RingsRoom>(
      { id: owned.id, action, ...body },
      context,
      '/api/otc-rings'
    );
    if (response.status !== 200)
      throw new Error(
        `Deal action ${action} returned ${response.status} ${JSON.stringify(response.data)}`
      );
    return response.data;
  }

  let makerRoom = await act(mk, 'open');
  let takerRoom = await act(tk, 'open');
  const unlock = (room: RingsRoom, main: SigningKey, wallet: string) =>
    unlockRingsDealWallet({
      origin: room.origin,
      genesis,
      offerId: room.id,
      wallet: address(wallet),
      signMessage: async (payload) => main.sign(payload),
    });
  const mkKey = await unlock(makerRoom, signers[0], mk.wallet);
  const tkKey = await unlock(takerRoom, signers[1], tk.wallet);
  await act(mk, 'key', { key: ringsBase64(mkKey.shieldedAddress().toBytes()) });
  takerRoom = await act(tk, 'key', { key: ringsBase64(tkKey.shieldedAddress().toBytes()) });
  makerRoom = await act(mk, 'view');

  const realFetch = globalThis.fetch.bind(globalThis);
  let loseFundingReply = true;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (String(input) !== '/api/otc-rings-rpc') return realFetch(input, init);
    const wallet = new Headers(init?.headers).get('x-otc-wallet');
    const body = JSON.parse(String(init?.body));
    const response = await request<Buffer>(
      body,
      wallet === mk.wallet ? mk : tk,
      '/api/otc-rings-rpc'
    );
    if (
      loseFundingReply &&
      body.path === '/' &&
      JSON.parse(body.body).method === 'sendTransaction'
    ) {
      loseFundingReply = false;
      throw new Error('Local browser disconnected after Solana submission');
    }
    return new Response(
      response.data instanceof Uint8Array
        ? new Uint8Array(response.data)
        : JSON.stringify(response.data),
      { status: response.status, headers: Object.fromEntries(response.headers) }
    );
  });

  const signal = AbortSignal.timeout(100_000);
  const mc = await connectRingsRoom(makerRoom, mk.wallet, signal);
  const tc = await connectRingsRoom(takerRoom, tk.wallet, signal);
  if (launch)
    await expect(checkRingsFundingAccess(tc, takerRoom)).rejects.toThrow(
      'token holder to fund first'
    );
  async function fund(room: RingsRoom, client: typeof mc, context: typeof mk, key: Keypair) {
    const registerToken = await checkRingsFundingAccess(client, room);
    expect(registerToken).toBe(!!launch && context.wallet === mk.wallet);
    const lifetime = await client.getLatestBlockhash();
    const tx = await buildRingsDeposit(
      room,
      address(context.wallet),
      lifetime.blockhash,
      registerToken
    );
    const funding = await signRingsFunding(tx, lifetime, async (transaction) => {
      transaction.instructions.unshift(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 })
      );
      transaction.sign(key);
      return transaction;
    });
    if (registerToken) funding.registerToken = true;
    await act(context, 'funding', { funding });
    const reloaded = await act(context, 'view');
    const pending = reloaded[reloaded.side].funding!;
    expect(pending.transaction).toBe(funding.transaction);
    expect(pending.registerToken).toBe(registerToken ? true : undefined);
    await publishRingsTransaction(client, pending.transaction, pending.signature).catch(
      (): undefined => undefined
    );
    await waitFinal(pending.signature);
    await publishRingsTransaction(client, pending.transaction, pending.signature);
    return pending;
  }

  const makerFunding = await fund(makerRoom, mc, mk, maker);
  const takerFunding = await fund(takerRoom, tc, tk, buyer);
  expect(loseFundingReply).toBe(false);
  async function waitFinal(signature: string) {
    await vi.waitFor(
      async () => {
        const status = await connection.getSignatureStatus(signature);
        expect(status.value?.err).toBeNull();
        expect(status.value?.confirmationStatus).toBe('finalized');
      },
      { timeout: 35_000, interval: 500 }
    );
  }
  await Promise.all([waitFinal(makerFunding.signature), waitFinal(takerFunding.signature)]);
  const assets = await ringsAssets(mc, makerRoom);
  makerRoom = await act(mk, 'view');
  takerRoom = await act(tk, 'view');
  const swap: RingsSwap = {
    maker: dealLeg(makerRoom, 'maker'),
    taker: dealLeg(makerRoom, 'taker'),
    expiresAt: BigInt(Math.floor(Date.parse(makerRoom.expiresAt) / 1000)),
  };
  const mf = await ownRingsFunding(mc, makerRoom, mkKey, assets);
  const tf = await ownRingsFunding(tc, takerRoom, tkKey, assets);
  const mp = encodeRingsProof(
    await proveRingsSwapLeg({ swap, side: 'maker', wallet: mkKey, funding: mf, assets, client: mc })
  );
  const tp = encodeRingsProof(
    await proveRingsSwapLeg({ swap, side: 'taker', wallet: tkKey, funding: tf, assets, client: tc })
  );
  await act(mk, 'proof', { proof: mp });
  await act(tk, 'proof', { proof: tp });
  const { attempt } = await act(mk, 'attempt');
  if (!attempt) throw new Error('No settlement attempt');
  const lifetime = {
    blockhash: blockhash(attempt.lifetime.blockhash),
    lastValidBlockHeight: BigInt(attempt.lifetime.lastValidBlockHeight),
  };
  const ms = await signRingsSwap({
    swap,
    side: 'maker',
    wallet: mkKey,
    funding: mf,
    assets,
    lifetime,
    outgoing: decodeRingsProof(mp),
    incoming: decodeRingsProof(tp),
  });
  const ts = await signRingsSwap({
    swap,
    side: 'taker',
    wallet: tkKey,
    funding: tf,
    assets,
    lifetime,
    outgoing: decodeRingsProof(tp),
    incoming: decodeRingsProof(mp),
  });
  await act(mk, 'sign', {
    attempt: attempt.id,
    partial: packRingsPartial(ms, swap.maker.owner.solanaAddress()),
  });
  await act(tk, 'sign', {
    attempt: attempt.id,
    partial: packRingsPartial(ts, swap.taker.owner.solanaAddress()),
  });
  const final = (await act(mk, 'view')).attempt!;
  const signed = await combineRingsSwapSignatures(
    swap,
    unpackRingsPartial(final.maker!, swap.maker.owner.solanaAddress()),
    unpackRingsPartial(final.taker!, swap.taker.owner.solanaAddress())
  );
  const tx = wireRingsTransaction(signed);
  await publishRingsTransaction(mc, tx.transaction, tx.signature);
  await waitFinal(tx.signature);

  const received = await readRingsNote(
    tc,
    tx.signature,
    tkKey,
    swap.maker.asset,
    swap.maker.amount,
    assets
  );
  expect(received.utxo.amount).toBe(swap.maker.amount);
  const paid = await readRingsNote(
    mc,
    tx.signature,
    mkKey,
    swap.taker.asset,
    swap.taker.amount,
    assets
  );
  async function recover(
    context: typeof mk,
    client: typeof mc,
    key: ShieldedKeypair,
    note: typeof paid,
    tokenProgram: Address
  ) {
    const withdrawal = await withdrawRingsNote(
      client,
      key,
      note,
      assets,
      address(context.wallet),
      tokenProgram
    );
    const saved = await act(context, 'withdrawal', { withdrawal });
    expect((await act(context, 'view'))[saved.side].withdrawal?.signature).toBe(
      withdrawal.signature
    );
    await publishRingsTransaction(client, withdrawal.transaction, withdrawal.signature);
    await waitFinal(withdrawal.signature);
  }
  await Promise.all([
    recover(tk, tc, tkKey, received, dealLeg(makerRoom, 'maker').tokenProgram),
    recover(mk, mc, mkKey, paid, dealLeg(takerRoom, 'taker').tokenProgram),
  ]);
  const reserve = await returnRingsReserve(tc, tkKey, address(tk.wallet));
  await act(tk, 'reserve', { reserve });
  await publishRingsTransaction(tc, reserve.transaction, reserve.signature);
  await waitFinal(reserve.signature);
  expect(await connection.getBalance(new PublicKey(tkKey.toSolanaSigner().address))).toBe(0);
  mkKey.destroy();
  tkKey.destroy();
  for (const key of signers) key.destroy();
}
