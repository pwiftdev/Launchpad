import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import type { GetServerSideProps } from 'next';
import Page from '@/components/ui/Page/Page';
import { buttonVariants } from '@/components/ui/button';
import { CoinPanel } from '@/components/coinpage/CoinPanel';
import { LogoMark } from '@/components/brand/Logo';
import { BRAND } from '@/constants/brand';
import { useCoin } from '@/hooks/useCoins';
import { parseKey } from '@/server/dbc';
import { findCoin } from '@/server/activity';
import { getDemoCoin } from '@/lib/demo';
import { adminPageRedirect } from '@/server/adminPage';

type ShareMeta = { mint: string; name: string; symbol: string; origin: string } | null;

/** Server-renders the link-preview tags so X/Telegram crawlers (no JS) see the coin's share card. */
export const getServerSideProps: GetServerSideProps<{ share: ShareMeta }> = async (context) => {
  const denied = adminPageRedirect(context);
  if (denied) return denied;
  const { params } = context;
  const mint = String(params?.tokenId ?? '');
  const coin =
    getDemoCoin(mint) ?? (parseKey(mint) ? await findCoin(mint).catch((): null => null) : null);
  if (!coin) return { notFound: true };
  const origin = BRAND.url;
  return {
    props: { share: coin ? { mint, name: coin.name, symbol: coin.symbol, origin } : null },
  };
};

/** Full-page version of the coin panel, for shared links and new tabs. */
export default function TokenPage({ share }: { share: ShareMeta }) {
  const { query } = useRouter();
  const mint = typeof query.tokenId === 'string' ? query.tokenId : undefined;
  const { data: coin, status, error } = useCoin(mint);
  const title = share ? `$${share.symbol} · ${share.name} | ${BRAND.name}` : BRAND.name;

  return (
    <Page app>
      <Head>
        <title>{title}</title>
        {share && (
          <>
            <meta key="og:title" property="og:title" content={title} />
            <meta key="og:description" property="og:description" content={BRAND.description} />
            <meta property="og:url" content={`${share.origin}/token/${share.mint}`} />
            <meta
              key="og:image"
              property="og:image"
              content={`${share.origin}/api/og/${share.mint}?v=${BRAND.shareImageVersion}`}
            />
            <meta key="og:image:width" property="og:image:width" content="1200" />
            <meta key="og:image:height" property="og:image:height" content="630" />
            <meta key="twitter:card" name="twitter:card" content="summary_large_image" />
            <meta
              key="twitter:image"
              name="twitter:image"
              content={`${share.origin}/api/og/${share.mint}?v=${BRAND.shareImageVersion}`}
            />
          </>
        )}
      </Head>
      {coin ? (
        <CoinPanel
          coin={coin}
          className="surface min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
          headerActions={
            <Link
              href="/"
              className="rounded-lg p-2 text-neutral-500 hover:bg-neutral-900 hover:text-neutral-100"
              aria-label="Back to the board"
            >
              <span className="iconify block h-5 w-5 ph--x" />
            </Link>
          }
        />
      ) : status === 'error' ? (
        <div className="mx-auto mt-16 flex max-w-md flex-col items-center text-center">
          <LogoMark className="h-14 w-16 opacity-50 grayscale" />
          <h1 className="mt-4 text-lg font-semibold">Not on {BRAND.name}</h1>
          <p className="mt-1 text-sm text-neutral-500">
            {error instanceof Error ? error.message : 'Coin not found'}
          </p>
          <Link href="/" className={buttonVariants({ variant: 'secondary', className: 'mt-6' })}>
            Back to the board
          </Link>
        </div>
      ) : (
        <div className="surface space-y-4 p-5" aria-busy>
          <div className="h-10 w-1/3 animate-pulse rounded-lg bg-neutral-900" />
          <div className="h-[420px] animate-pulse rounded-lg bg-neutral-900" />
        </div>
      )}
    </Page>
  );
}
