import Head from 'next/head';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import Page from '@/components/ui/Page/Page';
import { buttonVariants } from '@/components/ui/button';
import { BRAND } from '@/constants/brand';
import { explorerUrl, NETWORK_LABEL } from '@/constants/network';
import { formatTokenUnits } from '@/lib/tokenUnits';
export { requireAdminPage as getServerSideProps } from '@/server/adminPage';

type BurnFeed = {
  totals: { coins: string; buybacks: string; lamports: string };
  receipts: {
    mint: string;
    signature: string;
    finalizedSlot: string;
    lamports: string;
    tokenUnits: string;
  }[];
};
const sol = (value: string) => formatTokenUnits(value, 9);
const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-5)}`;

export default function Burns() {
  const feed = useQuery<BurnFeed>({
    queryKey: ['verified-burns'],
    queryFn: async () => {
      const response = await fetch('/api/burns', { signal: AbortSignal.timeout(15_000) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Burn feed unavailable');
      return body;
    },
    refetchInterval: 30_000,
    retry: 1,
  });
  const data = feed.data;
  return (
    <Page>
      <Head>
        <title>{`Burns | ${BRAND.name}`}</title>
      </Head>

      <header className="border-b border-neutral-850 pb-8">
        <p className="eyebrow">Verified burns · {NETWORK_LABEL}</p>
        <h1 className="mt-2 font-display text-3xl font-extrabold tracking-tight md:text-4xl">
          Every buyback, <span className="text-holo">on the record</span>
        </h1>
        <p className="mt-4 max-w-2xl text-neutral-400">
          Snipe-tax buybacks purchase the launched token and burn the received tokens in the same
          transaction. Only completed, finalized receipts appear here.
        </p>
      </header>

      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        {[
          ['Tokens with burns', data?.totals.coins ?? '—', 'ph--fire-fill', 'text-acid'],
          ['Buybacks', data?.totals.buybacks ?? '—', 'ph--arrows-clockwise-bold', 'text-primary'],
          ['SOL spent', data ? sol(data.totals.lamports) : '—', 'ph--coins-fill', 'text-primary'],
        ].map(([label, value, icon, color]) => (
          <div key={label} className="surface p-5">
            <span className={`iconify h-6 w-6 ${icon} ${color}`} />
            <p className="mt-3 text-xs uppercase tracking-wider text-neutral-500">{label}</p>
            <p className="mt-1 font-mono text-2xl font-semibold">{value}</p>
          </div>
        ))}
      </div>

      <section aria-label="Burn feed" className="surface mt-6 overflow-hidden">
        {feed.isError && (
          <p role="status" className="p-6 text-sm text-neutral-400">
            Could not refresh verified receipts.{' '}
            {data ? 'Previously loaded receipts are shown below.' : 'Try again shortly.'}
          </p>
        )}
        {!data?.receipts.length ? (
          <div className="flex flex-col items-center px-6 py-14 text-center">
            <span className="iconify h-12 w-12 text-neutral-700 ph--fire-bold" />
            <h2 className="mt-4 text-lg font-bold">
              {feed.isLoading
                ? 'Checking receipts…'
                : feed.isError
                  ? 'Receipts unavailable'
                  : 'No verified burns yet'}
            </h2>
            <p className="mt-1 max-w-md text-sm text-neutral-400">
              Pending jobs and estimated budgets never count as completed burns.
            </p>
            <Link href="/" className={buttonVariants({ className: 'mt-6' })}>
              Explore launches
            </Link>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-neutral-800 text-xs uppercase text-neutral-500">
                  <tr>
                    {['Token', 'Tokens burned', 'SOL spent', 'Finalized slot', 'Receipt'].map(
                      (label) => (
                        <th key={label} scope="col" className="whitespace-nowrap px-5 py-4">
                          {label}
                        </th>
                      )
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-800">
                  {data.receipts.map((receipt) => (
                    <tr key={receipt.signature}>
                      <td className="px-5 py-4">
                        <Link href={`/?coin=${receipt.mint}`} className="font-mono text-primary">
                          {short(receipt.mint)}
                        </Link>
                      </td>
                      <td className="whitespace-nowrap px-5 py-4 font-mono">
                        {formatTokenUnits(receipt.tokenUnits, 6)}
                      </td>
                      <td className="px-5 py-4 font-mono">{sol(receipt.lamports)}</td>
                      <td className="px-5 py-4 font-mono text-neutral-400">
                        {receipt.finalizedSlot}
                      </td>
                      <td className="px-5 py-4">
                        <a
                          href={explorerUrl(`tx/${receipt.signature}`)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary"
                        >
                          View ↗
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="border-t border-neutral-800 px-5 py-3 text-xs text-neutral-500">
              Latest 50 finalized buybacks. Token quantities belong to different mints and are not
              added together.
            </p>
          </>
        )}
      </section>
    </Page>
  );
}
