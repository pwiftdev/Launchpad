import Head from 'next/head';
import Link from 'next/link';
import { Wordmark } from '@/components/brand/Logo';
import { BRAND } from '@/constants/brand';

export default function Privacy() {
  return (
    <main className="mx-auto min-h-screen w-full max-w-3xl px-5 py-10 text-foreground">
      <Head>
        <title>Privacy | MSKD.fun</title>
      </Head>
      <Link href="/" className="mb-8 block w-fit" aria-label="MSKD.fun launchpad">
        <Wordmark className="text-xl" />
      </Link>
      <h1 className="mt-6 text-[40px] font-semibold leading-none tracking-[-0.045em]">Privacy</h1>
      <div className="surface mt-8 space-y-5 rounded-3xl p-6 text-[14.5px] leading-relaxed text-neutral-400 sm:p-8">
        <p>
          If you previously registered for early access, those records may include your public
          Solana wallet address, registration details, referral attribution, and the message and
          signature used to verify wallet ownership.
        </p>
        <p>
          The server uses hashed network identifiers to limit admin sign-in attempts. Admin sign-in
          uses an essential session cookie. The hosting provider may retain operational access logs
          under its own policies.
        </p>
        <p>
          Token chat uses a wallet signature and a session cookie to control access. We encrypt
          message text in storage and decrypt it for signed-in participants. Messages use a
          room-specific alias. Anyone who signs in with a wallet can read the room.
        </p>
        <p>
          Private launch previews use a wallet signature and a session cookie. We encrypt saved
          draft details and artwork in storage and keep a hash of each invite link. An active invite
          can be opened by anyone with its link, or only by the invited wallet if the creator
          restricts it. Revoking an invite stops future access. Viewers can still keep copies of
          what they have seen.
        </p>
        <p>
          For requests concerning past registration records, contact{' '}
          <a
            href={`https://x.com/${BRAND.xHandle.slice(1)}`}
            target="_blank"
            rel="noreferrer"
            className="text-primary"
          >
            {BRAND.xHandle}
          </a>{' '}
          to request deletion. We may ask for a wallet signature to verify ownership.
        </p>
      </div>
    </main>
  );
}
