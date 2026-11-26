import { generateKeyPairSync, sign } from 'node:crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { afterEach, expect, it, vi } from 'vitest';
import { launchMessage, type LaunchPayload } from '@/lib/launchAuth';
import { uploadPublicArtifact } from '@/server/pinata';
import { reserveLaunchIntent } from '@/server/launchRegistry';
import { OFFICIAL_MSKD, OFFICIAL_MSKD_RESERVED } from '@/server/officialMskd';
import { largeLaunchArtwork } from './launchArtworkFixture';

const { configKey, blockhash } = vi.hoisted(() => ({
  configKey: 'So11111111111111111111111111111111111111112',
  blockhash: '11111111111111111111111111111111',
}));
vi.mock('@meteora-ag/dynamic-bonding-curve-sdk', () => ({
  DynamicBondingCurveClient: class {
    creator = {
      createPool: ({ payer, baseMint }: { payer: PublicKey; baseMint: PublicKey }) =>
        new Transaction().add(
          SystemProgram.transfer({ fromPubkey: payer, toPubkey: baseMint, lamports: 1 })
        ),
    };
  },
}));
vi.mock('@/server/dbc', () => ({
  connection: {
    getSlot: vi.fn(async () => 5),
    getLatestBlockhashAndContext: vi.fn(async () => ({
      context: { slot: 5 },
      value: { blockhash, lastValidBlockHeight: 100 },
    })),
  },
  networkGenesis: vi.fn(async () => blockhash),
  cacheUploadedMetadata: vi.fn(async () => {}),
}));
vi.mock('@/server/tradingAccess', () => ({
  verifiedTradingAccess: vi.fn(async () => ({
    key: { toBase58: () => configKey },
    genesis: blockhash,
    record: {},
  })),
}));
vi.mock('@/server/launchRegistry', () => ({ reserveLaunchIntent: vi.fn(async () => {}) }));
vi.mock('@/server/launchUploadBudget', () => ({
  consumeLaunchUpload: vi.fn(async () => ({ allowed: true })),
}));
vi.mock('@/server/pinata', () => ({
  uploadPublicArtifact: vi.fn(async () => ({
    cid: 'bafkreihcfu4dqmbr5iyacioofllgwl2m7sv22bo6woiya6rpiwwcj6ksoi',
  })),
}));
vi.mock('@/server/tokenImageCache', () => ({ tokenImages: { seed: vi.fn(async () => {}) } }));

const origin = 'https://launch.example';

async function submit(handler: typeof import('@/pages/api/upload').default, body: unknown) {
  const response = { setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn() };
  await handler(
    {
      method: 'POST',
      url: '/api/upload',
      headers: { host: 'launch.example', origin, 'content-type': 'application/json' },
      socket: { remoteAddress: '127.0.0.1' },
      body,
    } as NextApiRequest,
    response as unknown as NextApiResponse
  );
  return response;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it('rejects reserved launch labels before storing an intent or uploading artifacts', async () => {
  vi.stubEnv('LAUNCHPAD_PUBLIC', 'true');
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', origin);
  vi.stubEnv('RPC_URL', 'https://rpc.example');
  vi.stubEnv('PINATA_JWT', 'test-only');
  const { default: upload } = await import('@/pages/api/upload');
  const request = {
    tokenName: OFFICIAL_MSKD.name,
    tokenSymbol: OFFICIAL_MSKD.symbol,
    tokenLogo: 'unused',
    userWallet: Keypair.generate().publicKey.toBase58(),
    mint: Keypair.generate().publicKey.toBase58(),
    devBuyPercent: 0,
    burnShare: 0,
    mode: 'masked',
    creatorShareBps: 5000,
    configKey,
    issuedAt: Date.now(),
    signature: 'A'.repeat(86) + '==',
  };
  const response = await submit(upload, request);
  expect(response.status).toHaveBeenCalledWith(403);
  expect(response.json).toHaveBeenCalledWith({ error: OFFICIAL_MSKD_RESERVED });
  const spoofedWallet = await submit(upload, {
    ...request,
    userWallet: OFFICIAL_MSKD.deployer,
    mint: OFFICIAL_MSKD.mint,
  });
  expect(spoofedWallet.status).toHaveBeenCalledWith(401);
  expect(reserveLaunchIntent).not.toHaveBeenCalled();
  expect(uploadPublicArtifact).not.toHaveBeenCalled();
});

it('prepares two launches with matching metadata and fresh mints, and rejects a replay', async () => {
  vi.stubEnv('LAUNCHPAD_PUBLIC', 'true');
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', origin);
  vi.stubEnv('RPC_URL', 'https://rpc.example');
  vi.stubEnv('PINATA_JWT', 'test-only');
  vi.stubEnv('ADMIN_SESSION_SECRET', 'test-only-launch-preparation-secret');
  const { default: upload } = await import('@/pages/api/upload');
  const keys = generateKeyPairSync('ed25519');
  const wallet = new PublicKey(
    keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)
  );
  const logo = await largeLaunchArtwork();
  expect(logo.length).toBeGreaterThan(5_000_000);
  const firstMint = Keypair.generate().publicKey.toBase58();
  const secondMint = Keypair.generate().publicKey.toBase58();
  const shared = {
    tokenName: 'Masked Frog',
    tokenSymbol: 'MASK',
    tokenLogo: `data:image/png;base64,${logo.toString('base64')}`,
    socials: { twitter: 'https://x.com/maskedfrog/status/12345?s=20#media' },
    userWallet: wallet.toBase58(),
    devBuyPercent: 0,
    burnShare: 0,
    mode: 'masked',
    creatorShareBps: 3000,
    configKey,
  } satisfies Omit<LaunchPayload, 'mint'>;
  const issuedAt = Date.now();
  const requests = await Promise.all(
    [firstMint, secondMint].map(async (mint) => {
      const payload = { ...shared, mint };
      const message = await launchMessage(payload, origin, issuedAt);
      return {
        ...payload,
        issuedAt,
        signature: sign(null, Buffer.from(message), keys.privateKey).toString('base64'),
      };
    })
  );

  for (const request of requests) {
    const response = await submit(upload, request);
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  }

  expect(
    vi
      .mocked(reserveLaunchIntent)
      .mock.calls.map(([intent]) => [intent.mint, intent.creatorShareBps])
  ).toEqual([
    [firstMint, 3000],
    [secondMint, 3000],
  ]);
  const artifacts = vi.mocked(uploadPublicArtifact).mock.calls.map(([artifact]) => artifact);
  const metadata = artifacts
    .filter(({ purpose }) => purpose === 'metadata')
    .map(({ buffer }) => JSON.parse(buffer.toString()));
  expect(metadata).toMatchObject(
    [firstMint, secondMint].map((mint) => ({
      mint,
      name: shared.tokenName,
      symbol: shared.tokenSymbol,
      twitter: shared.socials.twitter,
      extensions: shared.socials,
      launchMode: 'masked',
      feeSplit: { creatorShareBps: 3000 },
    }))
  );
  for (const record of metadata) expect(record).not.toHaveProperty('source');
  const artwork = artifacts.filter(({ purpose }) => purpose === 'image');
  expect(artwork).toHaveLength(2);
  expect(artwork[0]?.buffer).toEqual(artwork[1]?.buffer);
  expect((await submit(upload, requests[0])).status).toHaveBeenCalledWith(401);
  expect(uploadPublicArtifact).toHaveBeenCalledTimes(4);
});
