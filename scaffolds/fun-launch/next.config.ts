import type { NextConfig } from 'next';
import { createRequire } from 'node:module';
import path from 'node:path';

const wasmAliases = {
  'light_wasm_hasher_bg.wasm':
    './node_modules/@lightprotocol/hasher.rs/dist/light_wasm_hasher_bg.wasm',
  'hasher_wasm_simd_bg.wasm':
    './node_modules/@lightprotocol/hasher.rs/dist/hasher_wasm_simd_bg.wasm',
};
const requireFromApp = createRequire(path.join(__dirname, 'package.json'));
const nextConfig: NextConfig = {
  // Windows without Developer Mode cannot create the tracing symlinks. Heroku builds on Linux.
  output: process.platform === 'win32' ? undefined : 'standalone',
  outputFileTracingRoot: path.resolve(__dirname, '../..'),
  poweredByHeader: false,
  reactStrictMode: true,
  turbopack: { resolveAlias: wasmAliases },
  webpack(config, { isServer }) {
    if (!isServer) {
      config.resolve.alias = {
        ...config.resolve.alias,
        ...Object.fromEntries(
          Object.keys(wasmAliases).map((name) => [
            name,
            path.join(
              path.dirname(requireFromApp.resolve('@lightprotocol/hasher.rs/package.json')),
              'dist',
              name
            ),
          ])
        ),
      };
    }
    return config;
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          ...(process.env.NODE_ENV === 'production'
            ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000' }]
            : []),
        ],
      },
      {
        source: '/api/:artworkRoute(upload|launch-previews)',
        headers: [
          { key: 'Content-Security-Policy', value: "default-src 'none'; frame-ancestors 'none'" },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
        ],
      },
    ];
  },
  async redirects() {
    return [
      { source: '/create-pool', destination: '/launch', permanent: true },
      { source: '/watchlist', destination: '/?watchlist=1', permanent: true },
      { source: '/whitelist', destination: '/', permanent: true },
      { source: '/w/:code', destination: '/', permanent: true },
    ];
  },
};

export default nextConfig;
