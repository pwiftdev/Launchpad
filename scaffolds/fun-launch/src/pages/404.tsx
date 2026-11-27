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
        <span
          aria-hidden
          className="pointer-events-none absolute top-10 h-72 w-72 rounded-full bg-[radial-gradient(circle,rgba(255,110,20,0.3),transparent_65%)] blur-2xl"
        />
        <LogoMark className="mark-float relative h-40 w-28 drop-shadow-[0_20px_40px_rgba(255,102,0,0.45)]" />
        <p className="mt-4 font-mono text-8xl font-semibold tracking-[-0.06em]">
          <Decrypt text="404" className="text-holo" duration={1400} />
        </p>
        <h1 className="mt-4 text-2xl font-semibold tracking-[-0.03em]">
          Nothing here. Not even a trace.
        </h1>
        <p className="mt-2 max-w-sm text-sm text-neutral-400">
          Whatever was here left no fingerprints. Plenty of coins on the board still need you.
        </p>
        <Link
          href="/"
          className="btn-holo group mt-8 inline-flex h-12 items-center gap-2 px-6 text-[14px]"
        >
          Back to the board
          <span className="iconify h-4 w-4 transition-transform duration-200 ease-spring group-hover:translate-x-0.5 ph--arrow-right-bold" />
        </Link>
      </div>
    </main>
  );
}
