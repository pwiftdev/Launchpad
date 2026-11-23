import Head from 'next/head';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import type { GetServerSideProps } from 'next';
import { LogoMark, Wordmark } from '@/components/brand/Logo';
import { ADMIN_COOKIE, adminConfigured, readAdminSession } from '@/server/adminSession';
import { AdminLockButton } from '@/components/shell/AdminLockButton';

export const getServerSideProps: GetServerSideProps = async ({ req, res }) => {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Vary', 'Cookie');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
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
      <LogoMark className="h-20 w-24" />
      <Wordmark className="mt-5 text-2xl" />
      <section className="mt-8 w-full max-w-sm rounded-2xl border border-primary/20 bg-neutral-950 p-6 text-left">
        <p className="eyebrow text-primary">Administration</p>
        <h1 className="mt-2 font-display text-2xl font-bold">Admin entrance</h1>
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
              className="mt-4 flex h-12 items-center justify-center rounded-xl bg-primary font-semibold text-primary-950"
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
              className="mt-2 h-12 w-full rounded-xl border border-neutral-750 bg-background px-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
            <button
              type="submit"
              disabled={busy}
              className="mt-3 h-12 w-full rounded-xl bg-primary font-semibold text-primary-950 disabled:opacity-60"
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
          <p
            role="status"
            className="mt-6 rounded-xl border border-neutral-800 bg-background p-4 text-sm text-neutral-400"
          >
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
