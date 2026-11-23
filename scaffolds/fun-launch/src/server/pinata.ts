import { PublicKey } from '@solana/web3.js';

export type ArtifactIdentity = { mint: string; genesis: string; configKey: string };
/** Provider-side identity survives aborted HTTP requests and does not depend on process memory. */
export async function uploadPublicArtifact(
  args: ArtifactIdentity & {
    buffer: Buffer;
    contentType: string;
    fileName: string;
    purpose: 'image' | 'metadata';
    jwt: string;
  }
) {
  new PublicKey(args.mint);
  new PublicKey(args.configKey);
  new PublicKey(args.genesis);
  const form = new FormData();
  form.append(
    'file',
    new Blob([new Uint8Array(args.buffer)], { type: args.contentType }),
    args.fileName
  );
  form.append('network', 'public');
  form.append('name', args.fileName);
  form.append(
    'keyvalues',
    JSON.stringify({
      rinsed_app: 'launchpad-v1',
      rinsed_mint: args.mint,
      rinsed_genesis: args.genesis,
      rinsed_config: args.configKey,
      rinsed_purpose: args.purpose,
    })
  );
  const response = await fetch('https://uploads.pinata.cloud/v3/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${args.jwt}` },
    body: form,
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`Pinata upload failed: ${response.status}`);
  const result = (await response.json()) as { data?: { cid?: unknown; id?: unknown } };
  const cid = result.data?.cid,
    id = result.data?.id;
  if (
    typeof cid !== 'string' ||
    !/^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,120})$/.test(cid) ||
    typeof id !== 'string' ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)
  )
    throw new Error('Pinata returned an invalid artifact receipt');
  return { cid, id };
}
