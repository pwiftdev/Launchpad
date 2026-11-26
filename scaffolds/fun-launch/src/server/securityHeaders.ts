import { randomBytes } from 'node:crypto';

export const NONCE_HEADER = 'x-rinsed-nonce';
export function newScriptNonce() {
  return randomBytes(24).toString('base64');
}
export function validScriptNonce(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9+/]{32}$/.test(value);
}

/** Inline styles remain necessary for chart dimensions, wallet portals and component positioning. */
export function contentSecurityPolicy(
  nonce: string,
  development = process.env.NODE_ENV !== 'production',
  allowWasm = false
) {
  if (!validScriptNonce(nonce)) throw new Error('Invalid script nonce');
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : allowWasm ? " 'wasm-unsafe-eval'" : ''}`,
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: https:${development ? ' http://127.0.0.1:* http://localhost:*' : ''}`,
    "font-src 'self' data:",
    `connect-src 'self' https: wss:${development ? ' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*' : ''}`,
    'frame-src https://connect.solflare.com https://verify.walletconnect.org https://verify.walletconnect.com',
    "worker-src 'self' blob:",
    "media-src 'self' blob: data: https:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(development ? [] : ['upgrade-insecure-requests']),
  ].join('; ');
}
