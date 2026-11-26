import { NextApiRequest, NextApiResponse } from 'next';
import { PublicKey } from '@solana/web3.js';
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk';
import BN from 'bn.js';
import { DEV_BUY_MAX_PERCENT_OF_SUPPLY, LAUNCH_IMAGE_MAX_MB } from '@/constants/launch';
import { quoteDevBuy } from '@/server/devBuy';
import { apiGuard, clientIp, takeLimit } from '@/server/apiGuard';
import { siteOriginForHeaders } from '@/server/siteOrigin';
import { verifyLaunch } from '@/server/launchAuth';
import { consumeLaunchUpload } from '@/server/launchUploadBudget';
import { uploadSchema } from '@/server/validation';
import { decodeDataUrl, normalizeLaunchImage } from '@/server/launchImage';
import type { LaunchPayload } from '@/lib/launchAuth';
import { DEFAULT_IPFS_GATEWAY, imageSources } from '@/lib/ipfs';
import { verifiedTradingAccess } from '@/server/tradingAccess';
import { connection, networkGenesis } from '@/server/dbc';
import { attestLaunchPreparation } from '@/server/launchPreparation';
import { reserveLaunchIntent } from '@/server/launchRegistry';
import { launchPayloadDigest } from '@/lib/launchAuth';
import { assertLegacyPacketFits, TransactionSizeError } from '@/server/transactionSize';
import { uploadPublicArtifact, type ArtifactIdentity } from '@/server/pinata';
import { normalizeSocials, type Socials } from '@/lib/socials';
import { buildLaunchMetadata } from '@/server/launchMetadata';
import { tokenImages } from '@/server/tokenImageCache';
import { cacheUploadedMetadata } from '@/server/dbc';
import { allowsMskdIdentity, OFFICIAL_MSKD_RESERVED } from '@/server/officialMskd';

// Environment variables with type assertions
const PINATA_JWT = process.env.PINATA_JWT as string;
const IPFS_GATEWAY_URL = (process.env.IPFS_GATEWAY_URL || DEFAULT_IPFS_GATEWAY).replace(/\/$/, '');
const RPC_URL = process.env.RPC_URL as string;

// Leave room for the base64 image and JSON metadata within the request limit.
export const config = { api: { bodyParser: { sizeLimit: '8mb' } } };

// Types
type MetadataUploadParams = {
  tokenName: string;
  tokenSymbol: string;
  mint: string;
  image: string;
  source?: string;
  description?: string;
  socials: Socials;
  burnShare: number;
  mode?: import('@/lib/launchModes').LaunchMode;
  artifactIdentity: ArtifactIdentity;
};

let activeUploads = 0;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!apiGuard(req, res)) return;
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const parsed = uploadSchema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: 'Invalid launch fields, address, or authorization' });
  if (
    !allowsMskdIdentity({
      name: parsed.data.tokenName,
      symbol: parsed.data.tokenSymbol,
      mint: parsed.data.mint,
      deployer: parsed.data.userWallet,
    })
  )
    return res.status(403).json({ error: OFFICIAL_MSKD_RESERVED });
  if (!PINATA_JWT || !RPC_URL) {
    return res.status(503).json({ error: 'Launch service is not configured' });
  }
  const approved = await verifiedTradingAccess(parsed.data.mode).catch((): null => null);
  if (!approved)
    return res.status(503).json({ error: 'Selected mode has no reviewed launch config' });
  if (parsed.data.configKey && parsed.data.configKey !== approved.key.toBase58())
    return res.status(409).json({ error: 'Selected config changed. Refresh and sign again.' });
  if (!takeLimit(`upload-ip:${clientIp(req)}`, 5, 3600_000)) {
    res.setHeader('Retry-After', '3600');
    return res.status(429).json({ error: 'Launch limit reached. Try again later.' });
  }
  const origin = siteOriginForHeaders(req.headers);
  if (
    !(await verifyLaunch(
      parsed.data as LaunchPayload,
      new URL(origin).origin,
      parsed.data.issuedAt,
      parsed.data.signature
    ))
  ) {
    return res.status(401).json({ error: 'Sign a fresh launch authorization with your wallet' });
  }
  if (activeUploads >= 2)
    return res.status(503).json({ error: 'Launch service is busy. Try again shortly.' });
  activeUploads++;
  try {
    if (parsed.data.mode || process.env.DATABASE_URL) {
      const admission = await consumeLaunchUpload({
        wallet: parsed.data.userWallet,
        signature: parsed.data.signature,
      });
      if ('reason' in admission) {
        if (admission.reason === 'replayed')
          return res
            .status(401)
            .json({ error: 'Sign a fresh launch authorization with your wallet' });
        res.setHeader('Retry-After', '3600');
        return res.status(429).json({ error: 'Launch limit reached. Try again later.' });
      }
    } else if (
      !takeLimit(`upload-wallet:${parsed.data.userWallet}`, 3, 3600_000) ||
      !takeLimit('upload-budget', 20, 3600_000)
    ) {
      // Only the unregistered, database-free legacy devnet preview uses process-local budgets.
      res.setHeader('Retry-After', '3600');
      return res.status(429).json({ error: 'Launch limit reached. Try again later.' });
    }
    if (parsed.data.mode) {
      if (!approved.record) throw new Error('Reviewed launch policy is required');
      await reserveLaunchIntent({
        genesis: approved.genesis,
        mint: parsed.data.mint,
        configKey: approved.key.toBase58(),
        deployer: parsed.data.userWallet,
        mode: parsed.data.mode,
        payloadDigest: await launchPayloadDigest(parsed.data),
        preparedSlot: await connection.getSlot('finalized'),
      });
    }
    const {
      tokenLogo,
      tokenName,
      tokenSymbol,
      mint,
      userWallet,
      devBuyPercent = 0,
      sourceUrl,
      description,
      burnShare = 0,
      mode,
    } = parsed.data;
    const socials = normalizeSocials(parsed.data.socials);

    // Validate required fields
    if (!tokenLogo || !tokenName || !tokenSymbol || !mint || !userWallet) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (Buffer.byteLength(tokenName, 'utf8') > 32 || Buffer.byteLength(tokenSymbol, 'utf8') > 10) {
      return res.status(400).json({ error: 'Name max 32 UTF-8 bytes, ticker max 10 UTF-8 bytes' });
    }
    if (!(devBuyPercent >= 0 && devBuyPercent <= DEV_BUY_MAX_PERCENT_OF_SUPPLY)) {
      return res
        .status(400)
        .json({ error: `Dev buy is capped at ${DEV_BUY_MAX_PERCENT_OF_SUPPLY}% of supply` });
    }
    const image = await normalizeLaunchImage(decodeDataUrl(tokenLogo)).catch((): null => null);
    if (!image) {
      return res
        .status(400)
        .json({ error: `Use a PNG, JPG, GIF or WebP image up to ${LAUNCH_IMAGE_MAX_MB} MB.` });
    }

    // Upload image and metadata
    const artifactIdentity = {
      mint,
      genesis: approved.genesis,
      configKey: approved.key.toBase58(),
    };
    const imageUrl = await uploadImage(image, mint, artifactIdentity);
    if (!imageUrl) {
      return res.status(400).json({ error: 'Failed to upload image' });
    }

    const metadataUrl = await uploadMetadata({
      tokenName,
      tokenSymbol,
      mint,
      image: imageUrl,
      source: sourceUrl || undefined,
      burnShare,
      description,
      socials,
      mode,
      artifactIdentity,
    });
    if (!metadataUrl) {
      return res.status(400).json({ error: 'Failed to upload metadata' });
    }

    // Create pool transaction
    const poolTx = await createPoolTransaction({
      mint,
      tokenName,
      tokenSymbol,
      metadataUrl,
      userWallet,
      devBuyPercent,
      approved,
    });

    res.status(200).json({
      success: true,
      imageUrl,
      ...poolTx.context,
      poolTx: poolTx.transaction
        .serialize({
          requireAllSignatures: false,
          verifySignatures: false,
        })
        .toString('base64'),
    });
  } catch (error) {
    if (error instanceof TransactionSizeError)
      return res.status(422).json({ error: error.message });
    console.error('Launch preparation failed');
    res.status(500).json({ error: 'Could not prepare your launch. Please try again.' });
  } finally {
    activeUploads--;
  }
}

async function uploadImage(
  image: { buffer: Buffer; contentType: string },
  mint: string,
  identity: ArtifactIdentity
): Promise<string | false> {
  const fileName = `${mint}.${image.contentType.split('/')[1]}`;

  try {
    const { cid } = await uploadPublicArtifact({
      ...identity,
      buffer: image.buffer,
      contentType: image.contentType,
      fileName,
      purpose: 'image',
      jwt: PINATA_JWT,
    });
    const uri = imageSources(`${IPFS_GATEWAY_URL}/ipfs/${cid}`)[0];
    if (!uri) return false;
    await tokenImages.seed(uri, image.buffer).catch(() => {});
    return uri;
  } catch {
    console.error('Image upload failed');
    return false;
  }
}

async function uploadMetadata(params: MetadataUploadParams): Promise<string | false> {
  const metadata = buildLaunchMetadata(params);
  const fileName = `${params.mint}.json`;

  try {
    const { cid } = await uploadPublicArtifact({
      ...params.artifactIdentity,
      buffer: Buffer.from(JSON.stringify(metadata, null, 2)),
      contentType: 'application/json',
      fileName,
      purpose: 'metadata',
      jwt: PINATA_JWT,
    });
    const uri = imageSources(`${IPFS_GATEWAY_URL}/ipfs/${cid}`)[0];
    if (!uri) return false;
    await cacheUploadedMetadata(uri, metadata).catch(() => {});
    return uri;
  } catch {
    console.error('Metadata upload failed');
    return false;
  }
}

async function createPoolTransaction({
  mint,
  tokenName,
  tokenSymbol,
  metadataUrl,
  userWallet,
  devBuyPercent,
  approved,
}: {
  mint: string;
  tokenName: string;
  tokenSymbol: string;
  metadataUrl: string;
  userWallet: string;
  devBuyPercent: number;
  approved: Awaited<ReturnType<typeof verifiedTradingAccess>>;
}) {
  const client = new DynamicBondingCurveClient(connection, 'confirmed');
  const creator = new PublicKey(userWallet);

  const createPoolParam = {
    config: approved.key,
    baseMint: new PublicKey(mint),
    name: tokenName,
    symbol: tokenSymbol,
    uri: metadataUrl,
    payer: creator,
    poolCreator: creator,
  };

  // The dev first buy shares the create transaction, so the program charges it the 1.25% min fee.
  // Spending exactly the quoted cost caps it at the requested share of supply.
  let poolTx;
  if (devBuyPercent > 0) {
    const devBuy = await quoteDevBuy(devBuyPercent, approved.config);
    const tokensOut = new BN(devBuy.tokens).mul(new BN(10 ** approved.config.tokenDecimal));
    poolTx = await client.creator.createPoolWithFirstBuy({
      createPoolParam,
      firstBuyParam: {
        buyer: creator,
        buyAmount: devBuy.costLamports,
        minimumAmountOut: tokensOut.muln(99).divn(100),
        referralTokenAccount: null,
      },
    });
  } else {
    poolTx = await client.creator.createPool(createPoolParam);
  }
  const prepared = await connection.getLatestBlockhashAndContext('finalized');
  poolTx.feePayer = new PublicKey(userWallet);
  poolTx.recentBlockhash = prepared.value.blockhash;
  assertLegacyPacketFits(poolTx);
  if ((await networkGenesis(true)) !== approved.genesis)
    throw new Error('Launch preparation network changed');
  return {
    transaction: poolTx,
    context: attestLaunchPreparation({
      transaction: poolTx,
      mint,
      wallet: userWallet,
      genesis: approved.genesis,
      preparedSlot: prepared.context.slot,
      lastValidBlockHeight: prepared.value.lastValidBlockHeight,
    }),
  };
}
