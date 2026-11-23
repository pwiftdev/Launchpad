import Head from 'next/head';
import Link from 'next/link';
import { Wordmark } from '@/components/brand/Logo';
import { BRAND } from '@/constants/brand';

export default function Privacy() {
  return (
    <main className="mx-auto min-h-screen w-full max-w-3xl px-5 py-10 text-foreground">
      <Head>
        <title>Registration privacy | MSKD.fun</title>
      </Head>
      <Link href="/" className="mb-8 block w-fit" aria-label="MSKD.fun launchpad">
        <Wordmark className="text-xl" />
      </Link>
      <Link href="/whitelist" className="text-sm text-primary">
        ← Back to registration
      </Link>
      <h1 className="mt-6 text-3xl font-semibold">Registration privacy</h1>
      <div className="mt-6 space-y-5 text-sm leading-relaxed text-neutral-400">
        <p>
          When you register for the optional $MSKD airdrop, we save your public Solana wallet
          address, selected interest, registration time, registration status, and the message and
          signature used to verify wallet ownership.
        </p>
        <p>
          Each registration receives a shareable invite code. If you join through an invite, we also
          record the inviting wallet. Invite links display a shortened version of that wallet
          address, and inviters can see how many active wallets joined through their link. Your
          browser remembers an invite code for the current session.
        </p>
        <p>
          We use this information to maintain the registration list and prepare the $MSKD airdrop.
          Referral counts will help determine airdrop allocations. Registration does not authorize
          transactions, payments, or token spending. We do not collect recovery phrases, private
          keys, email addresses, or identity documents through this form.
        </p>
        <p>
          The server uses short-lived, hashed network identifiers to limit abuse. We do not store
          your raw IP address in the registration database. The hosting provider may retain
          operational access logs under its own policies.
        </p>
        <p>
          A secure, HTTP-only cookie remembers your registration on this browser for up to 30 days.
          It is used for registration status, not advertising. Your wallet address and signature are
          not published as a public list. Admin sign-ins use a separate essential session cookie.
        </p>
        <p>
          Registration records are retained for the early-access program. Contact{' '}
          <a
            href={`https://x.com/${BRAND.xHandle.slice(1)}`}
            target="_blank"
            rel="noreferrer"
            className="text-primary"
          >
            {BRAND.xHandle}
          </a>{' '}
          for a deletion request; we may ask for a new wallet signature to verify ownership.
        </p>
        <p>
          Whitelisters will receive a $MSKD airdrop, with larger allocations for more successful
          referrals. Registration records your wallet and referral attribution; allocation and
          distribution details will be announced. Claims are not open yet. This notice was updated
          on 27 October 2026.
        </p>
      </div>
    </main>
  );
}
