import { deriveMintMetadata } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { SHIELDED_POOL_PROGRAM_ID } from '@heliuslabs/spr';
import {
  getProtocolConfigAddress,
  getSplAssetRegistryAddress,
  getSplAssetVaultAddress,
} from '@heliuslabs/spr/addresses';
import { decodeProtocolConfig, decodeSplAssetRegistry } from '@heliuslabs/spr/interface';
import {
  ExtensionType,
  getExtensionTypes,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  unpackAccount,
  unpackMint,
} from '@solana/spl-token';
import { PublicKey, type AccountInfo } from '@solana/web3.js';
import { address } from '@solana/kit';
import { OFFICIAL_MSKD } from '@/constants/officialMskd';
import type { OtcToken, OtcTokenPage } from '@/lib/otc';
import { ringsAsset } from '@/lib/otcRingsDeposit';
import { NETWORK_GENESIS } from '../../../../scripts/network-policy.cjs';
import { registeredCoin } from './launchRegistry';
import { database } from './database';
import { readBorshString } from './mintMetadata';
import { otcRingsConfig } from './otcRingsConfig';
import { ringsConnection } from './otcRingsRetry';
import { SocialError } from './profileStore';

const metadataProgram = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const safeExtensions = new Set([
  ExtensionType.MetadataPointer,
  ExtensionType.TokenMetadata,
  ExtensionType.GroupPointer,
  ExtensionType.TokenGroup,
  ExtensionType.GroupMemberPointer,
  ExtensionType.TokenGroupMember,
]);

function readSymbol(mint: PublicKey, metadata: AccountInfo<Buffer> | null | undefined) {
  if (
    !metadata?.owner.equals(metadataProgram) ||
    !metadata.data.subarray(33, 65).equals(mint.toBuffer())
  )
    return 'Token';
  try {
    const [, cursor] = readBorshString(metadata.data, 65);
    const [symbol] = readBorshString(metadata.data, cursor);
    return /^[\p{L}\p{N}._$-]{1,18}$/u.test(symbol) && !/^(sol|usdc|mskd)$/i.test(symbol)
      ? symbol
      : 'Token';
  } catch {
    return 'Token';
  }
}

export async function listOtcTokens(genesis: string, after: string | null): Promise<OtcTokenPage> {
  const rings = otcRingsConfig();
  if (!rings?.enabled)
    throw new SocialError('Launchpad token settlement is unavailable here.', 409);
  const { rows } = await database().query<{ mint: string }>(
    'SELECT mint FROM launch_coins WHERE network_genesis=$1 AND ($2::varchar IS NULL OR mint>$2) ORDER BY mint LIMIT 25',
    [genesis, after]
  );
  const page = rows.slice(0, 24).map(({ mint }) => new PublicKey(mint));
  if (!page.length) return { tokens: [], next: null };
  const metadata = await ringsConnection(rings.rpc).getMultipleAccountsInfo(
    page.map(deriveMintMetadata),
    'finalized'
  );
  return {
    tokens: page.map((key, index) => ({
      mint: key.toBase58(),
      symbol:
        key.toBase58() === OFFICIAL_MSKD.mint
          ? OFFICIAL_MSKD.symbol
          : readSymbol(key, metadata[index]),
    })),
    next: rows.length > page.length ? page.at(-1)!.toBase58() : null,
  };
}

export async function resolveOtcToken(genesis: string, mintAddress: string): Promise<OtcToken> {
  const rings = otcRingsConfig();
  if (!rings?.enabled)
    throw new SocialError('Launchpad token settlement is unavailable here.', 409);
  const mint = new PublicKey(mintAddress);
  const id = address(mint.toBase58());
  if (
    id === ringsAsset('SOL', genesis) ||
    id === ringsAsset('USDC', genesis, process.env.OTC_RINGS_LOCAL_USDC_MINT)
  )
    throw new SocialError('Use the SOL / USDC pair for quote assets.', 400);
  const official = id === OFFICIAL_MSKD.mint && genesis === NETWORK_GENESIS['mainnet-beta'];
  if (!official && !(await registeredCoin(genesis, id)))
    throw new SocialError('Choose a token launched on this launchpad.', 404);
  const connection = ringsConnection(rings.rpc);
  const [registryAddress, vaultAddress, configAddress] = await Promise.all([
    getSplAssetRegistryAddress(id),
    getSplAssetVaultAddress(id),
    getProtocolConfigAddress(),
  ]);
  const [mintInfo, registry, vault, config, metadata] = await connection.getMultipleAccountsInfo(
    [
      mint,
      new PublicKey(registryAddress),
      new PublicKey(vaultAddress),
      new PublicKey(configAddress),
      deriveMintMetadata(mint),
    ],
    'finalized'
  );
  if (
    !mintInfo ||
    (!mintInfo.owner.equals(TOKEN_PROGRAM_ID) && !mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID))
  )
    throw new SocialError('That mint is unavailable on this network.', 404);
  const decoded = unpackMint(mint, mintInfo, mintInfo.owner);
  if (
    !decoded.isInitialized ||
    decoded.decimals > 9 ||
    decoded.freezeAuthority ||
    getExtensionTypes(decoded.tlvData).some((extension) => !safeExtensions.has(extension))
  )
    throw new SocialError('This token cannot safely settle through Rings.', 409);
  if (registry?.data.length) {
    if (
      registry.owner.toBase58() !== SHIELDED_POOL_PROGRAM_ID ||
      decodeSplAssetRegistry(registry.data).mint !== id ||
      !vault?.owner.equals(mintInfo.owner)
    )
      throw new SocialError('The Rings token account is unavailable.', 409);
    const token = unpackAccount(new PublicKey(vaultAddress), vault, mintInfo.owner);
    if (!token.isInitialized || token.isFrozen || !token.mint.equals(mint))
      throw new SocialError('The Rings token account is unavailable.', 409);
  } else if (
    config?.owner.toBase58() !== SHIELDED_POOL_PROGRAM_ID ||
    !decodeProtocolConfig(config.data).splInterfaceCreationIsPermissionless
  ) {
    throw new SocialError('This token still needs setup in Helius Rings.', 409);
  }
  return {
    mint: id,
    symbol: official ? OFFICIAL_MSKD.symbol : readSymbol(mint, metadata),
    decimals: decoded.decimals,
    program: mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID) ? 'token-2022' : 'spl',
  };
}
