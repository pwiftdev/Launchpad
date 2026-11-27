import Head from 'next/head';
import Link from 'next/link';
import type { GetServerSideProps } from 'next';
import Page from '@/components/ui/Page/Page';
import { BRAND } from '@/constants/brand';
import { explorerUrl } from '@/constants/network';
import { adminPageRedirect } from '@/server/adminPage';
import { transactionSignature } from '@/lib/accessRoutes';
import { formatSol, formatTokenUnits } from '@/lib/tokenUnits';
import type { BurnReceipt } from '@/lib/proof';

const MSKD_DECIMALS = 6;

export const getServerSideProps: GetServerSideProps<{ receipt: BurnReceipt }> = async (context) => {
  const blocked = adminPageRedirect(context);
  if (blocked) return blocked;
  const signature = String(context.params?.signature ?? '');
  if (!transactionSignature(signature) || !process.env.DATABASE_URL) return { notFound: true };
  const [{ networkGenesis }, { burnReceipt }] = await Promise.all([
    import('@/server/dbc'),
    import('@/server/proof'),
  ]);
  const receipt = await burnReceipt(await networkGenesis(), signature);
  return receipt ? { props: { receipt } } : { notFound: true };
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-neutral-850 py-3">
      <dt className="text-xs text-neutral-500">{label}</dt>
      <dd className="font-mono text-sm">{children}</dd>
    </div>
  );
}

/** The public receipt for one $MSKD buyback and burn. Every number is checkable on chain. */
export default function BurnReceiptPage({ receipt }: { receipt: BurnReceipt }) {
  const burned = formatTokenUnits(receipt.tokens, MSKD_DECIMALS);
  return (
    <Page containerClassName="max-w-2xl">
      <Head>
        <title>{`$MSKD burn #${receipt.number} | ${BRAND.name}`}</title>
        <meta
          name="description"
          content={`${burned} $MSKD bought with ${formatSol(receipt.lamports)} and burned.`}
        />
      </Head>
      <header className="pb-6 pt-4 md:pt-8">
        <Link href="/proof" className="eyebrow hover:text-primary">
          ← Proof
        </Link>
        <h1 className="mt-4 font-display text-[28px] uppercase leading-[1.05] md:text-[40px]">
          Burn #{receipt.number}
        </h1>
        <p className="mt-3 text-[15px] text-neutral-400">
          {burned} $MSKD bought with {formatSol(receipt.lamports)} and destroyed in the same
          transaction.
        </p>
      </header>
      <section className="surface p-6">
        <dl>
          <Row label="When">{new Date(receipt.at).toUTCString()}</Row>
          <Row label="SOL spent">{formatSol(receipt.lamports)}</Row>
          <Row label="$MSKD burned">{burned}</Row>
          <Row label="Bought from">
            {receipt.pool ? (
              <a
                href={explorerUrl(`address/${receipt.pool}`)}
                target="_blank"
                rel="noreferrer"
                className="hover:text-primary"
              >
                {receipt.route === 'damm-v2' ? 'Graduated pool' : 'Bonding curve'}{' '}
                {receipt.pool.slice(0, 6)}…
              </a>
            ) : (
              'Unrecorded'
            )}
          </Row>
          <Row label="Burned to date">
            {formatTokenUnits(receipt.burnedToDateTokens, MSKD_DECIMALS)} $MSKD over{' '}
            {receipt.number} burn{receipt.number === 1 ? '' : 's'}
          </Row>
          <Row label="Funded by Masked trading to date">
            {formatSol(receipt.fundedByMaskedLamports)}
          </Row>
          {receipt.supply && (
            <Row label="$MSKD supply now">
              {formatTokenUnits(receipt.supply.amount, receipt.supply.decimals)}
            </Row>
          )}
          <Row label="Transaction">
            <a
              href={explorerUrl(`tx/${receipt.signature}`)}
              target="_blank"
              rel="noreferrer"
              className="hover:text-primary"
            >
              {receipt.signature.slice(0, 10)}…{receipt.signature.slice(-10)}
            </a>
          </Row>
        </dl>
        <p className="mt-5 text-xs leading-relaxed text-neutral-500">
          Open the transaction: it shows the company fee wallet buying $MSKD and burning exactly
          that amount, with nothing left over. Masked records a burn only after checking both
          against the finalized chain. Every Masked trade sends 0.10% to this budget.
        </p>
      </section>
    </Page>
  );
}
