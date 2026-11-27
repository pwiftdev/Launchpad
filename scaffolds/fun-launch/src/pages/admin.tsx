import Head from 'next/head';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import type { GetServerSideProps } from 'next';
import { LogoMark, Wordmark } from '@/components/brand/Logo';
import { ADMIN_COOKIE, adminConfigured, readAdminSession } from '@/server/adminSession';
import { AdminLockButton } from '@/components/shell/AdminLockButton';
import { launchpadIsPublic } from '@/lib/accessRoutes';

export const getServerSideProps: GetServerSideProps = async ({ req, res }) => {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Vary', 'Cookie');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  if (launchpadIsPublic()) return { redirect: { destination: '/', permanent: false } };
  return {
    props: {
      authenticated: readAdminSession(req.cookies[ADMIN_COOKIE]),
      configured: adminConfigured(),
    },
  };
};

export default function Admin({
  authenticated,
  configured,
}: {
  authenticated: boolean;
  configured: boolean;
}) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/admin/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'login', key }),
        signal: AbortSignal.timeout(20000),
      });
      setKey('');
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not sign in.');
      window.location.replace('/');
    } catch (reason) {
      setKey('');
      setError(reason instanceof Error ? reason.message : 'Could not sign in.');
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-5 py-12 text-center">
      <Head>
        <title>Admin | MSKD.fun</title>
        <meta name="robots" content="noindex, nofollow" />
      </Head>
      <LogoMark className="mark-float h-20 w-24 drop-shadow-[0_16px_34px_rgba(255,102,0,0.45)]" />
      <Wordmark className="mt-5 text-2xl" />
      <section className="holo-border enter mt-8 w-full max-w-sm rounded-3xl p-6 text-left">
        <p className="eyebrow text-primary">Administration</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Admin entrance</h1>
        <p className="mt-2 text-sm leading-relaxed text-neutral-400">
          Sign in to manage the launchpad. Browsing, launching and trading are open to everyone.
        </p>
        {authenticated ? (
          <>
            <div className="mt-6 flex items-center justify-between">
              <p className="text-sm text-emerald">You are signed in.</p>
              <AdminLockButton />
            </div>
            <Link
              href="/"
              className="btn-holo mt-4 flex h-12 items-center justify-center rounded-2xl text-[15px]"
            >
              Enter launchpad
            </Link>
          </>
        ) : configured ? (
          <form className="mt-6" onSubmit={submit}>
            <label htmlFor="admin-key" className="text-sm font-medium">
              Admin key
            </label>
            <input
              id="admin-key"
              name="admin-key"
              type="password"
              autoComplete="current-password"
              autoCapitalize="none"
              spellCheck={false}
              required
              minLength={16}
              maxLength={256}
              value={key}
              onChange={(event) => setKey(event.target.value)}
              disabled={busy}
              className="well mt-2 h-12 w-full rounded-xl px-3.5 text-sm outline-none transition-all duration-200 ease-out focus:border-primary/50 focus:shadow-[inset_0_1px_2px_rgba(0,0,0,0.35),0_0_0_4px_rgba(255,102,0,0.12)]"
            />
            <button
              type="submit"
              disabled={busy}
              className="btn-holo mt-3 h-12 w-full rounded-2xl text-[15px] disabled:opacity-60"
            >
              {busy ? 'Checking key…' : 'Sign in as admin'}
            </button>
            {error && (
              <p role="alert" className="mt-3 text-sm text-rose">
                {error}
              </p>
            )}
          </form>
        ) : (
          <p role="status" className="well mt-6 rounded-2xl p-4 text-sm text-neutral-400">
            Admin access is locked until private setup is complete.
          </p>
        )}
      </section>
      <Link href="/" className="mt-6 text-sm text-neutral-400 hover:text-primary">
        Back to the launchpad
      </Link>
    </main>
  );
}
