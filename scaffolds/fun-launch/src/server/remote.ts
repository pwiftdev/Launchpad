// Untrusted on-chain metadata must never choose arbitrary server destinations.
import { imageSources } from '@/lib/ipfs';
const GATEWAYS = new Set(['ipfs.io', 'gateway.pinata.cloud', 'cloudflare-ipfs.com', 'arweave.net']);
const MAX_PENDING = 64;
let active = 0;
const waiting: Array<() => void> = [];

export function remoteUrl(value: string): URL {
  const url = new URL(value);
  const configured = process.env.IPFS_GATEWAY_URL
    ? new URL(process.env.IPFS_GATEWAY_URL).hostname
    : undefined;
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !(
      GATEWAYS.has(url.hostname) ||
      url.hostname.endsWith('.mypinata.cloud') ||
      url.hostname === configured
    )
  )
    throw new Error('Untrusted metadata host');
  if (url.hostname !== 'arweave.net' && !url.pathname.startsWith('/ipfs/')) {
    throw new Error('Expected an IPFS content path');
  }
  return url;
}

export async function readLimited(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error('Remote request failed');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    if (Number(response.headers.get('content-length')) > maxBytes)
      throw new Error('Remote file too large');
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > maxBytes) throw new Error('Remote file too large');
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function fetchRemote(value: string, maxBytes: number): Promise<Buffer> {
  // Validate the original destination before deriving alternatives. Never follow redirects.
  const original = value.startsWith('ipfs://') ? imageSources(value)[0] : value;
  if (!original) throw new Error('Missing metadata URL');
  remoteUrl(original);
  const urls = imageSources(value).map(remoteUrl);
  if (active >= 6) {
    if (waiting.length >= MAX_PENDING) throw new Error('Remote fetch queue full');
    await new Promise<void>((resolve) => waiting.push(resolve));
  } else active++;
  try {
    let failure: unknown;
    for (const url of urls) {
      try {
        const response = await fetch(url, {
          redirect: 'error',
          signal: AbortSignal.timeout(10000),
        });
        return await readLimited(response, maxBytes);
      } catch (error) {
        failure = error;
      }
    }
    throw failure;
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}
