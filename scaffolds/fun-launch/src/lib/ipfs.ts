export const DEFAULT_IPFS_GATEWAY = 'https://gateway.pinata.cloud';

const PUBLIC_IPFS_HOSTS = new Set(['ipfs.io', 'gateway.pinata.cloud', 'cloudflare-ipfs.com']);

/** Equivalent public URLs for the same IPFS content, with a dependable path gateway first. */
export function imageSources(value: string): string[] {
  try {
    const native = value.startsWith('ipfs://');
    const url = new URL(
      native ? `${DEFAULT_IPFS_GATEWAY}/ipfs/${value.slice(7).replace(/^ipfs\//, '')}` : value
    );
    const known = PUBLIC_IPFS_HOSTS.has(url.hostname) || url.hostname.endsWith('.mypinata.cloud');
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      !known ||
      !/^\/ipfs\/[A-Za-z0-9]{20,128}(?:\/.*)?$/.test(url.pathname)
    )
      return [value];
    const publicUrls = [`${DEFAULT_IPFS_GATEWAY}${url.pathname}`, `https://ipfs.io${url.pathname}`];
    return [
      ...new Set(
        url.hostname.endsWith('.mypinata.cloud')
          ? [url.href, ...publicUrls]
          : [...publicUrls, url.href]
      ),
    ];
  } catch {
    return [value];
  }
}

/** Browsers use our durable artwork cache first, retaining direct gateway fallbacks. */
export function tokenImageSources(value: string): string[] {
  const sources = imageSources(value);
  try {
    const url = new URL(sources[0]!);
    if (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      (((PUBLIC_IPFS_HOSTS.has(url.hostname) || url.hostname.endsWith('.mypinata.cloud')) &&
        /^\/ipfs\/[A-Za-z0-9]{20,128}(?:\/.*)?$/.test(url.pathname)) ||
        url.hostname === 'arweave.net')
    )
      return [`/api/token-image?uri=${encodeURIComponent(url.href)}`, ...sources];
  } catch {
    /* Local artwork and previews load directly. */
  }
  return sources;
}
