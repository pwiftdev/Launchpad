import type { Coin, Holder, HoldersResponse, Trade, TradesResponse, TrendingCoin } from './coin';
import { TOTAL_SUPPLY } from '@/constants/launch';
import { computePot } from './pot';
import { taxPercentAt } from './launchTax';

export const DEMO_ENABLED =
  process.env.NEXT_PUBLIC_NETWORK === 'devnet' && process.env.NEXT_PUBLIC_DEMO_LAUNCHES === 'true';

// These deliberately invalid mint IDs keep preview content out of every transaction API.
type Seed = [
  slug: string,
  name: string,
  symbol: string,
  progress: number,
  ageMinutes: number,
  capSol: number,
  description: string,
];
export const DEMO_SEEDS: Seed[] = [
  ['bubble-cat', 'Bubble Cat', 'BUBBLE', 0.04, 3, 31, 'Nine lives. Infinite bubbles.'],
  [
    'rinse-frog',
    'Rinse Frog',
    'RIBBIT',
    0.11,
    7,
    46,
    'A little frog with a very clean conscience.',
  ],
  ['soap-dog', 'Soap Dog', 'SUDS', 0.02, 11, 22, 'Good boy. Fresh coat.'],
  ['moon-duck', 'Moon Duck', 'QUACK', 0.19, 16, 68, 'One small waddle for duckkind.'],
  ['cosmic-capy', 'Cosmic Capy', 'CAPY', 0.08, 23, 37, 'Unbothered, moisturized, in orbit.'],
  ['mint-otter', 'Mint Otter', 'OTTER', 0.22, 31, 82, 'Holding on to the good stuff.'],
  ['peach-panda', 'Peach Panda', 'PEACH', 0.06, 38, 28, 'Soft paws. Sweet ambitions.'],
  ['disco-shrimp', 'Disco Shrimp', 'SHRIMP', 0.15, 46, 55, 'Small shrimp. Big dance floor.'],
  ['tiny-whale', 'Tiny Whale', 'TINY', 0.03, 53, 25, 'Making little waves.'],
  ['cloud-bunny', 'Cloud Bunny', 'CLOUD', 0.12, 64, 43, 'A softer place to land.'],
  ['pixel-pigeon', 'Pixel Pigeon', 'COO', 0.94, 41, 690, 'Street smart. Pixel perfect.'],
  [
    'rocket-raccoon',
    'Rocket Raccoon',
    'TRASH',
    0.87,
    76,
    545,
    'Turning yesterday’s trash into tomorrow’s rocket fuel.',
  ],
  ['lucky-lobster', 'Lucky Lobster', 'CLAW', 0.79, 94, 420, 'A little luck. A lot of claw.'],
  ['jelly-jam', 'Jelly Jam', 'JELLY', 0.68, 115, 325, 'Go with the glow.'],
  ['turbo-turtle', 'Turbo Turtle', 'TURBO', 0.58, 139, 260, 'Slow shell. Fast dreams.'],
  ['noodle-dragon', 'Noodle Dragon', 'NOODLE', 0.46, 171, 194, 'A spicy little legend.'],
  ['soda-sloth', 'Soda Sloth', 'FIZZ', 0.36, 208, 155, 'Stay fizzy. Take it easy.'],
  ['honey-bear', 'Honey Bear', 'HONEY', 0.29, 253, 118, 'Sweet by nature.'],
  ['cactus-club', 'Cactus Club', 'PRICKLY', 0.52, 321, 235, 'A soft spot for sharp characters.'],
  ['sushi-shark', 'Sushi Shark', 'SUSHI', 1, 432, 1880, 'Fresh rolls. Friendly teeth.'],
  ['sleepy-sun', 'Sleepy Sun', 'SUNNY', 1, 589, 2690, 'Golden hour, all day.'],
  ['orbit-owl', 'Orbit Owl', 'HOOT', 1, 736, 4120, 'Eyes on the night sky.'],
  ['velvet-fox', 'Velvet Fox', 'VELVET', 1, 912, 1360, 'A little clever. A little cozy.'],
  ['mango-moth', 'Mango Moth', 'MANGO', 1, 1174, 3250, 'Drawn to the brighter side.'],
  ['neon-newt', 'Neon Newt', 'NEWT', 1, 1581, 5680, 'Tiny creature. Electric personality.'],
];

const previewStartedAt = Math.floor(Date.now() / 1000);

export function getDemoCoins(at = previewStartedAt): Coin[] {
  return DEMO_SEEDS.map(([slug, name, symbol, progress, age, cap, description], i) => ({
    isDemo: true,
    description,
    mint: `demo-${slug}`,
    pool: `demo-pool-${slug}`,
    creator: `PreviewCreator${String(i + 1).padStart(2, '0')}`,
    name,
    symbol,
    image: `/demo/coins/${slug}.webp`,
    launchedAt: at - age * 60,
    quoteReserveSol: progress * 80,
    thresholdSol: 80,
    progress,
    isMigrated: progress === 1,
    priceSol: cap / TOTAL_SUPPLY,
    marketCapSol: cap,
  }));
}

export function getDemoCoin(mint: string | undefined): Coin | undefined {
  return DEMO_ENABLED ? getDemoCoins().find((coin) => coin.mint === mint) : undefined;
}

function random(seed: number) {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export function getDemoTrades(coin: Coin): TradesResponse {
  const index = DEMO_SEEDS.findIndex(([slug]) => coin.mint === `demo-${slug}`);
  const rng = random(index + 37);
  const duration = previewStartedAt - coin.launchedAt - 5;
  const startCap = coin.marketCapSol * (0.14 + (index % 4) * 0.04);
  const trades: Trade[] = Array.from({ length: 96 }, (_, i) => {
    const t = (i + 1) / 96;
    const envelope = Math.sin(Math.PI * t);
    const drift = startCap + (coin.marketCapSol - startCap) * t;
    const wave = (Math.sin(t * 21 + index) * 0.18 + (rng() - 0.5) * 0.22) * envelope;
    const cap = Math.max(drift * (1 + wave), startCap * 0.6);
    const side = rng() > 0.35 ? ('buy' as const) : ('sell' as const);
    const elapsed = Math.floor(duration * t);
    const value = 0.06 + rng() * (coin.isMigrated ? 4 : 1.4);
    const fee = (value * taxPercentAt(elapsed)) / 100;
    return {
      sig: `demo-trade-${index}-${i}`,
      ts: coin.launchedAt + elapsed,
      side,
      wallet: `PreviewWallet${String(1 + Math.floor(rng() * 18)).padStart(2, '0')}`,
      sol: side === 'buy' ? value : value - fee,
      tokens: value / (cap / TOTAL_SUPPLY),
      feeSol: fee,
      priceSol: cap / TOTAL_SUPPLY,
      marketCapSol: cap,
    };
  }).reverse();
  return {
    trades,
    launchPriceSol: startCap / TOTAL_SUPPLY,
    pot: computePot(trades, coin.launchedAt),
    complete: true,
  };
}

export function getDemoHolders(coin: Coin): HoldersResponse {
  const circulating = Math.floor(TOTAL_SUPPLY * (0.04 + coin.progress * 0.68));
  const holders: Holder[] = Array.from({ length: 16 }, (_, i) => {
    const share = 0.054 * Math.exp(-i * 0.13);
    return {
      owner: `PreviewWallet${String(i + 1).padStart(2, '0')}`,
      amount: Math.floor(circulating * share),
      shareOfCirculating: share,
      isCreator: false,
    };
  });
  return { holders, circulating };
}

export function getDemoTrending(): TrendingCoin[] {
  return getDemoCoins()
    .filter((coin) => !coin.isMigrated)
    .map((coin, i) => ({ ...coin, txLastHour: 31 + ((i * 73 + 43) % 690) }))
    .sort((a, b) => b.txLastHour - a.txLastHour)
    .slice(0, 6);
}
