import type { NextConfig } from 'next';
import path from 'node:path';

const nextConfig: NextConfig = {
  // Windows without Developer Mode cannot create the tracing symlinks. Heroku builds on Linux.
  output: process.platform === 'win32' ? undefined : 'standalone',
  outputFileTracingRoot: path.resolve(__dirname, '../..'),
  poweredByHeader: false,
  reactStrictMode: true,
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
        source: '/api/:artworkRoute(upload)',
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
