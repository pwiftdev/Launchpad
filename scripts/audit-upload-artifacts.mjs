// Read-only inventory. Unpinning a shared CID can break another token's image/metadata.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { expectedNetworkGenesis } from './network-policy.cjs';
const app = createRequire(new URL('../scaffolds/fun-launch/package.json', import.meta.url));
const { Connection, PublicKey } = app('@solana/web3.js');
const { NATIVE_MINT } = app('@solana/spl-token');
const { DYNAMIC_BONDING_CURVE_PROGRAM_ID, deriveDbcPoolAddress } = app(
  '@meteora-ag/dynamic-bonding-curve-sdk'
);

export function artifactIdentity(file, expectedGenesis, now = Date.now()) {
  const tags = file?.keyvalues;
  if (tags?.rinsed_app !== 'launchpad-v1' || !['image', 'metadata'].includes(tags.rinsed_purpose))
    return null;
  try {
    new PublicKey(tags.rinsed_mint);
    new PublicKey(tags.rinsed_config);
    new PublicKey(tags.rinsed_genesis);
    const created = Date.parse(file.created_at);
    if (!Number.isFinite(created) || created > now) return { status: 'invalid_timestamp' };
    if (tags.rinsed_genesis !== expectedGenesis) return { status: 'different_chain' };
    if (now - created < 24 * 3600_000) return { status: 'retention_window' };
    return {
      status: 'check_chain',
      mint: tags.rinsed_mint,
      config: tags.rinsed_config,
      purpose: tags.rinsed_purpose,
    };
  } catch {
    return { status: 'invalid_identity' };
  }
}

export async function auditUploads(env = process.env) {
  if (!env.PINATA_JWT || !env.RPC_URL)
    throw new Error('PINATA_JWT and the independently configured RPC/network are required');
  const expected = expectedNetworkGenesis(env),
    connection = new Connection(env.RPC_URL, {
      commitment: 'finalized',
      disableRetryOnRateLimit: true,
      fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(10_000) }),
    });
  if ((await connection.getGenesisHash()) !== expected)
    throw new Error('RPC genesis does not match the configured network');
  const files = [],
    pages = new Set();
  let pageToken,
    complete = false;
  for (let page = 0; page < 100; page++) {
    const url = new URL('https://api.pinata.cloud/v3/files/public');
    url.searchParams.set('limit', '100');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${env.PINATA_JWT}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Artifact inventory failed (${response.status})`);
    const body = await response.json();
    if (!Array.isArray(body.data?.files)) throw new Error('Unknown artifact inventory format');
    files.push(...body.data.files);
    const next = body.data.next_page_token;
    if (!next) {
      complete = true;
      break;
    }
    if (typeof next !== 'string' || next.length > 2048 || pages.has(next))
      throw new Error('Invalid inventory pagination');
    pages.add(next);
    pageToken = next;
  }
  const artifacts = [];
  const references = new Map();
  for (const file of files) references.set(file.cid, (references.get(file.cid) ?? 0) + 1);
  for (const file of files) {
    const identity = artifactIdentity(file, expected);
    if (!identity) continue;
    let status = identity.status;
    if (status === 'check_chain') {
      const mint = new PublicKey(identity.mint),
        config = new PublicKey(identity.config);
      const pool = deriveDbcPoolAddress(NATIVE_MINT, mint, config);
      const [mintAccount, poolAccount, configAccount] = await connection.getMultipleAccountsInfo(
        [mint, pool, config],
        'finalized'
      );
      if (mintAccount || poolAccount) status = 'preserve_chain_account_exists';
      else if (!configAccount?.owner.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID))
        status = 'preserve_unknown_config';
      else
        status =
          (references.get(file.cid) ?? 0) > 1
            ? 'preserve_shared_cid'
            : 'candidate_requires_reference_review';
    }
    artifacts.push({
      id: file.id,
      cid: file.cid,
      name: file.name,
      createdAt: file.created_at,
      ...identity,
      status,
    });
  }
  return {
    networkGenesis: expected,
    complete,
    scannedFiles: files.length,
    artifacts,
    deletionPerformed: false,
    note: 'Read-only inventory. Candidates require shared-reference review; existing untagged files are not classified.',
  };
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (process.argv.length > 2) {
    console.error('This command accepts no write/delete flags.');
    process.exitCode = 1;
  } else
    auditUploads()
      .then((result) => console.log(JSON.stringify(result, null, 2)))
      .catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
      });
}
