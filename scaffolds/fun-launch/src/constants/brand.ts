import { OFFICIAL_MSKD } from './officialMskd';

// MASKED (mskd.fun): supplied mask + wordmark art and shared colors for HTML, canvas,
// wallet metadata and share cards. Black and white first; Monero orange is the only accent.
const assets = {
  /** White mask on transparent (dark surfaces) */
  mark: '/brand/mskd-mark.webp',
  markSmall: '/brand/mskd-mark-128.webp',
  markPng: '/brand/mskd-mark.png',
  /** Black mask on transparent (light surfaces) */
  markBlack: '/brand/mskd-mark-black.webp',
  markBlackSmall: '/brand/mskd-mark-black-128.webp',
  /** MSKD.fun wordmark, white and black */
  wordmark: '/brand/mskd-wordmark.webp',
  wordmarkPng: '/brand/mskd-wordmark.png',
  wordmarkBlack: '/brand/mskd-wordmark-black.webp',
  iconDark: '/brand/mskd-icon-dark.png',
  iconLight: '/brand/mskd-icon-light.png',
  icon192: '/brand/mskd-icon-192.png',
  icon512: '/brand/mskd-icon-512.png',
  appleTouch: '/brand/mskd-apple-touch-icon.png',
  favicon: '/brand/mskd-favicon-32.png',
  communityInvite: '/brand/mskd-community-invite.jpg',
  /** Avatar for the $MSKD token card: black mask on Monero orange */
  token: '/brand/mskd-token.png',
} as const;

export const BRAND = {
  name: 'MSKD.fun',
  /** Spoken / long-form name */
  longName: 'MASKED',
  wordmark: { main: 'MSKD', tld: '.fun' },
  ticker: 'MSKD',
  tagline: 'Earn from every trade. Cash out in Monero.',
  headline: { top: 'Earn from every trade.', bottom: 'Cash out in Monero.' },
  /** Three-beat promise used in heroes, splash and share cards */
  promise: ['No KYC', 'Locked fee split', 'Claim in XMR or SOL'] as const,
  description:
    'MASKED is the Solana launchpad where every trade pays the people behind the coin. The creator splits 0.60% of every trade with holders, locked at launch, and anyone can cash out in native Monero or SOL. 1.25% flat. Powered by Meteora.',
  url: (process.env.NEXT_PUBLIC_SITE_URL || 'https://mskd.fun').replace(/\/$/, ''),
  xHandle: '@mskdfun',
  telegramInvite: 'https://t.me/+4pNeyu06EkgzMTRk',
  shareImageVersion: 'mskd-20261126',
  logo: assets.mark,
  wordmarkImage: assets.wordmark,
  assets,
  /** Mint of the first-party $MSKD token pinned on the board; null hides the card until it exists. */
  officialMint: process.env.NEXT_PUBLIC_NETWORK === 'mainnet-beta' ? OFFICIAL_MSKD.mint : null,
  colors: {
    /** Monero orange, our only accent (sampled from getmonero.org's official symbol) */
    orange: '#FF6600',
    /** Monero grey, the symbol's second color */
    moneroGrey: '#4C4C4C',
    white: '#FFFFFF',
    black: '#090909',
    ink: '#0A0A0A',
    grey: '#8C8C8C',
    line: '#262626',
    up: '#2EE67A',
    down: '#FF455A',
    background: '#090909',
    surface: '#0A0A0A',
  },
  themeColor: '#090909',
} as const;
