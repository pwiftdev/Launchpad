import { Fragment, useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import type { GetServerSideProps } from 'next';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import Page from '@/components/ui/Page/Page';
import { Decrypt } from '@/components/brand/Decrypt';
import { BRAND } from '@/constants/brand';
import { NETWORK, explorerUrl } from '@/constants/network';
import { adminPageRedirect } from '@/server/adminPage';
import { formatXmr } from '@/lib/monero';
import { formatWxmr } from '@/lib/maskedEarnings';
import { formatSol, formatTokenUnits } from '@/lib/tokenUnits';
import type { ProofDay, ProofReceipt, ProofView } from '@/lib/proof';

export const getServerSideProps: GetServerSideProps = async (context) =>
  adminPageRedirect(context) ?? { props: {} };

const MSKD_DECIMALS = 6;
const moneroTx = (hash: string) =>
  `https://${NETWORK === 'mainnet-beta' ? '' : 'stagenet.'}xmrchain.net/tx/${hash}`;
const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-6)}`;
const xmr = (atomic: string | bigint) => `${formatXmr(BigInt(atomic))} XMR`;
const total = (days: ProofDay[], pick: (day: ProofDay) => string) =>
  days.reduce((sum, day) => sum + BigInt(pick(day)), 0n);
const ago = (iso: string) => {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  return minutes < 1
    ? 'just now'
    : minutes < 120
      ? `${minutes} min ago`
      : `${Math.round(minutes / 60)} h ago`;
};

function copy(text: string, what: string) {
  navigator.clipboard
    .writeText(text)
    .then(() => toast.success(`${what} copied`))
    .catch(() => toast.error('Copy failed'));
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="tile tile-hover p-4">
      <p className="text-xs text-neutral-500">{label}</p>
      <p className="mt-2 font-mono text-[22px] font-semibold tracking-tight">{value}</p>
      {note && <p className="mt-1 text-xs text-neutral-500">{note}</p>}
    </div>
  );
}

function Receipts({
  title,
  rows,
  tokens,
}: {
  title: string;
  rows: ProofReceipt[];
  tokens?: boolean;
}) {
  return (
    <div>
      <p className="text-sm font-semibold">{title}</p>
      {rows.length === 0 ? (
        <p className="mt-2 text-xs text-neutral-500">None yet.</p>
      ) : (
        <ul className="mt-2 divide-y divide-white/[0.05] text-xs">
          {rows.map((row) => (
            <li key={row.signature} className="flex items-center gap-3 py-2">
              <a
                href={explorerUrl(`tx/${row.signature}`)}
                target="_blank"
                rel="noreferrer"
                className="font-mono hover:text-primary"
              >
                {short(row.signature)}
              </a>
              <span className="text-neutral-500">{ago(row.at)}</span>
              {tokens && (
                <Link href={`/proof/burn/${row.signature}`} className="hover:text-primary">
                  Receipt
                </Link>
              )}
              <span className="ml-auto font-mono">
                {tokens && row.tokens
                  ? `${formatTokenUnits(row.tokens, MSKD_DECIMALS)} $MSKD`
                  : formatSol(row.lamports)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Public proof: every fee, burn and payout, the reserves behind them, and who holds which key. */
export default function Proof() {
  const proof = useQuery<ProofView>({
    queryKey: ['proof'],
    queryFn: async ({ signal }) => {
      const response = await fetch('/api/proof', { signal });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'Proof is unavailable');
      return body;
    },
    refetchInterval: 60_000,
  });
  const [open, setOpen] = useState<string | null>(null);
  const data = proof.data;
  const hasNativeHistory = data?.days.some(
    (day) => BigInt(day.xmrPaidAtomic) > 0n || BigInt(day.xmrReceivedAtomic) > 0n
  );

  return (
    <Page containerClassName="max-w-4xl">
      <Head>
        <title>{`Proof | ${BRAND.name}`}</title>
      </Head>
      <header className="pb-8 pt-4 md:pt-8">
        <p className="eyebrow">Proof</p>
        <h1 className="mt-4 text-[30px] font-semibold leading-[1.02] tracking-[-0.045em] md:text-[44px]">
          <Decrypt text="Every fee in." />
          <br />
          <Decrypt text="Every payout out." delay={160} className="text-holo" />
        </h1>
        <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-neutral-400">
          What Masked collected, burned and paid each day, what it holds against what it owes, and
          which keys control what. wXMR and SOL payouts appear as daily totals. Transfers are public
          on Solana.
        </p>
      </header>

      {proof.isLoading ? (
        <div className="surface space-y-3 rounded-3xl p-6" aria-busy aria-label="Loading proof">
          <div className="skeleton h-3 w-24" />
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="skeleton h-20 rounded-2xl" />
            <div className="skeleton h-20 rounded-2xl" />
            <div className="skeleton h-20 rounded-2xl" />
          </div>
        </div>
      ) : proof.error || !data ? (
        <div className="surface rounded-3xl p-6 text-sm text-rose" role="alert">
          {proof.error instanceof Error ? proof.error.message : 'Proof is unavailable'}
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          <section className="surface rounded-3xl p-6" aria-labelledby="totals">
            <p id="totals" className="eyebrow">
              Last 30 days
            </p>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <Stat
                label="Trading fees collected"
                value={formatSol(total(data.days, (day) => day.feesCollectedLamports))}
              />
              <Stat
                label="Earnings paid (SOL value)"
                value={formatSol(
                  total(data.days, (day) => day.solPaidLamports) +
                    total(data.days, (day) => day.wxmrPaidLamports) +
                    total(data.days, (day) => day.xmrPaidLamports)
                )}
                note={`${formatWxmr(total(data.days, (day) => day.wxmrPaidAtomic))} sent on Solana`}
              />
              <Stat
                label="$MSKD bought and burned"
                value={`${formatTokenUnits(
                  total(data.days, (day) => day.mskdBurnedTokens),
                  MSKD_DECIMALS
                )} $MSKD`}
                note={`for ${formatSol(total(data.days, (day) => day.mskdBoughtLamports))}`}
              />
            </div>
          </section>

          {data.reserves && (
            <section className="surface rounded-3xl p-6" aria-labelledby="reserves">
              <p id="reserves" className="eyebrow">
                Reserves
              </p>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <Stat
                  label="Fee income held for payout"
                  value={formatSol(data.reserves.heldLamports)}
                  note="Every share not yet paid out, ours included"
                />
                <Stat
                  label="Company fee wallet holds"
                  value={
                    data.reserves.balanceLamports === null
                      ? 'Unavailable'
                      : formatSol(data.reserves.balanceLamports)
                  }
                  note={
                    data.reserves.balanceLamports !== null &&
                    BigInt(data.reserves.balanceLamports) >= BigInt(data.reserves.heldLamports)
                      ? 'Covers everything held for payout'
                      : 'Checked on chain'
                  }
                />
                {data.reserves.xmrUnlockedAtomic !== null && (
                  <Stat
                    label="Monero treasury can spend"
                    value={xmr(data.reserves.xmrUnlockedAtomic)}
                    note={
                      data.reserves.xmrHeartbeatAt
                        ? `Reported ${ago(data.reserves.xmrHeartbeatAt)}`
                        : undefined
                    }
                  />
                )}
                {data.reserves.xmrClaimsWaiting > 0 && (
                  <Stat
                    label="Native XMR claims waiting"
                    value={String(data.reserves.xmrClaimsWaiting)}
                    note={`${formatSol(data.reserves.xmrClaimsWaitingLamports)} of earnings`}
                  />
                )}
              </div>
              <p className="mt-3 text-xs text-neutral-500">
                Check the fee wallet yourself:{' '}
                <a
                  href={explorerUrl(`address/${data.reserves.collector}`)}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono hover:text-primary"
                >
                  {short(data.reserves.collector)}
                </a>
              </p>
            </section>
          )}

          <section className="surface rounded-3xl p-6" aria-labelledby="daily">
            <p id="daily" className="eyebrow">
              Day by day (UTC)
            </p>
            {data.days.length === 0 ? (
              <p className="mt-4 text-sm text-neutral-500">Nothing collected or paid yet.</p>
            ) : (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[640px] text-left text-xs">
                  <thead className="text-neutral-500">
                    <tr className="border-b border-white/[0.06]">
                      <th className="py-2 font-medium">Day</th>
                      <th className="py-2 font-medium">Fees collected</th>
                      <th className="py-2 font-medium">Paid in SOL</th>
                      <th className="py-2 font-medium">Paid in wXMR</th>
                      {hasNativeHistory && (
                        <>
                          <th className="py-2 font-medium">Paid in native XMR</th>
                          <th className="py-2 font-medium">XMR received</th>
                        </>
                      )}
                      <th className="py-2 font-medium">$MSKD burned</th>
                      <th className="py-2 text-right font-medium">People paid</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {data.days.map((day) => (
                      <Fragment key={day.day}>
                        <tr
                          className="cursor-pointer border-b border-white/[0.06] hover:bg-white/[0.035]"
                          onClick={() => setOpen(open === day.day ? null : day.day)}
                          aria-expanded={open === day.day}
                        >
                          <td className="py-2">{day.day}</td>
                          <td className="py-2">{formatSol(day.feesCollectedLamports)}</td>
                          <td className="py-2">{formatSol(day.solPaidLamports)}</td>
                          <td className="py-2">{formatWxmr(day.wxmrPaidAtomic)}</td>
                          {hasNativeHistory && (
                            <>
                              <td className="py-2">{xmr(day.xmrPaidAtomic)}</td>
                              <td className="py-2">{xmr(day.xmrReceivedAtomic)}</td>
                            </>
                          )}
                          <td className="py-2">
                            {formatTokenUnits(day.mskdBurnedTokens, MSKD_DECIMALS)}
                          </td>
                          <td className="py-2 text-right">{day.peoplePaid}</td>
                        </tr>
                        {open === day.day && (
                          <tr className="border-b border-white/[0.06]">
                            <td
                              colSpan={hasNativeHistory ? 8 : 6}
                              className="py-3 font-sans text-neutral-400"
                            >
                              <p>
                                {day.collections} fee collection
                                {day.collections === 1 ? '' : 's'} · {day.burns} burn
                                {day.burns === 1 ? '' : 's'}
                              </p>
                              {day.xmrTransactions.length > 0 && (
                                <p className="mt-2">
                                  Monero payout transactions:{' '}
                                  {day.xmrTransactions.map((hash) => (
                                    <a
                                      key={hash}
                                      href={moneroTx(hash)}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="mr-3 font-mono hover:text-primary"
                                    >
                                      {short(hash)}
                                    </a>
                                  ))}
                                </p>
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section
            className="surface grid gap-6 rounded-3xl p-6 md:grid-cols-2"
            aria-label="Receipts"
          >
            <Receipts title="Latest fee collections" rows={data.recentCollections} />
            <Receipts title="Latest $MSKD burns" rows={data.recentBurns} tokens />
          </section>

          <section className="surface rounded-3xl p-6" aria-labelledby="treasury">
            <p id="treasury" className="eyebrow">
              Monero treasury
            </p>
            {!data.treasury ? (
              <p className="mt-4 text-sm text-neutral-500">
                Direct payouts to Monero wallets are in development.
              </p>
            ) : (
              <div className="mt-4 flex flex-col gap-4 text-sm">
                <p className="text-neutral-400">
                  Anyone can watch this wallet. Import the address and view key into a view-only
                  Monero wallet to see everything it receives. Import the key images to see what it
                  spends.
                </p>
                {[
                  ['Address', data.treasury.address],
                  ['Private view key', data.treasury.viewKey],
                ].map(([label, value]) => (
                  <div key={label}>
                    <p className="text-xs text-neutral-500">{label}</p>
                    <button
                      type="button"
                      onClick={() => copy(value!, label!)}
                      className="well mt-1 w-full break-all rounded-xl px-3.5 py-2.5 text-left font-mono text-xs transition-colors duration-200 hover:border-white/20"
                    >
                      {value}
                    </button>
                  </div>
                ))}
                <p className="text-xs">
                  {data.treasury.verified ? (
                    <span className="text-primary">
                      The view key matches this address (checked on this page’s server).
                    </span>
                  ) : (
                    <span className="text-rose">
                      The view key does not match this address. Do not rely on it.
                    </span>
                  )}
                  {data.treasury.restoreHeight &&
                    ` Scan from block ${data.treasury.restoreHeight}.`}
                </p>
                <div className="flex flex-wrap items-center gap-3">
                  {data.treasury.keyImages ? (
                    <>
                      <a
                        href="/api/proof/key-images"
                        download
                        className="btn-holo inline-flex h-10 items-center px-4 text-[13px]"
                      >
                        Download key images
                      </a>
                      <span className="text-xs text-neutral-500">
                        {data.treasury.keyImages.count} key images at block{' '}
                        {data.treasury.keyImages.walletHeight}, exported{' '}
                        {ago(data.treasury.keyImages.exportedAt)}
                      </span>
                    </>
                  ) : (
                    <span className="text-xs text-neutral-500">No key images exported yet.</span>
                  )}
                </div>
                <details className="text-xs text-neutral-400">
                  <summary className="cursor-pointer text-neutral-300">
                    How to check it yourself
                  </summary>
                  <ol className="mt-2 list-decimal space-y-1 pl-5">
                    <li>
                      Run{' '}
                      <code className="font-mono">
                        monero-wallet-cli --generate-from-view-key audit
                      </code>
                      {NETWORK === 'mainnet-beta' ? '' : ' --stagenet'} and paste the address and
                      view key. The wallet refuses a key that does not belong to the address.
                    </li>
                    <li>Let it sync. Its balance shows everything the treasury has received.</li>
                    <li>
                      Run <code className="font-mono">import_key_images</code> with the downloaded
                      file through monero-wallet-rpc. The wallet then shows what was spent, so its
                      balance matches the treasury’s.
                    </li>
                  </ol>
                </details>
              </div>
            )}
          </section>

          <section className="surface rounded-3xl p-6" aria-labelledby="controls">
            <p id="controls" className="eyebrow">
              Who controls what
            </p>
            <ul className="mt-4 divide-y divide-white/[0.05]">
              {data.controls.map((control) => (
                <li key={`${control.label}:${control.address}`} className="py-3">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="text-sm font-semibold">{control.label}</span>
                    {control.kind === 'solana' ? (
                      <a
                        href={explorerUrl(
                          control.label === '$MSKD token'
                            ? `token/${control.address}`
                            : `address/${control.address}`
                        )}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono text-xs text-neutral-400 hover:text-primary"
                      >
                        {short(control.address)}
                      </a>
                    ) : (
                      <span className="font-mono text-xs text-neutral-400">
                        {short(control.address)}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-neutral-500">{control.role}</p>
                </li>
              ))}
            </ul>
          </section>
          <p className="text-xs text-neutral-600">Updated {ago(data.generatedAt)}.</p>
        </div>
      )}
    </Page>
  );
}
