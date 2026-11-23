import Head from 'next/head';
import Link from 'next/link';
import { LogoMark } from '@/components/brand/Logo';
import { Decrypt } from '@/components/brand/Decrypt';
import { BRAND } from '@/constants/brand';

export default function NotFound() {
  return (
    <main className="relative mx-auto flex min-h-screen max-w-2xl items-center px-5">
      <Head>
        <title>{`Lost | ${BRAND.name}`}</title>
      </Head>
      <div className="relative flex w-full flex-col items-center py-16 text-center">
        <LogoMark className="h-40 w-28" />
        <p className="mt-4 font-mono text-7xl font-semibold tracking-tight">
          <Decrypt text="404" className="text-holo" duration={1400} />
        </p>
        <h1 className="mt-4 text-xl font-semibold tracking-tight">
          Nothing here. Not even a trace.
        </h1>
        <p className="mt-2 max-w-sm text-sm text-neutral-400">
          Whatever was here left no fingerprints. Plenty of coins on the board still need you.
        </p>
        <Link
          href="/"
          className="btn-holo mt-8 inline-flex h-11 items-center gap-2 rounded-lg px-5 text-sm"
        >
          Back to the board
          <span className="iconify h-4 w-4 ph--arrow-right" />
        </Link>
      </div>
    </main>
  );
}
