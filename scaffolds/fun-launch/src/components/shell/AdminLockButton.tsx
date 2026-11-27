import { useState } from 'react';
import { toast } from 'sonner';

export const AdminLockButton = () => {
  const [busy, setBusy] = useState(false);
  async function signOut() {
    setBusy(true);
    try {
      const response = await fetch('/api/admin/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'logout' }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error('Could not sign out. Please try again.');
      window.location.replace('/');
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Could not sign out.');
      setBusy(false);
    }
  }
  return (
    <button
      type="button"
      onClick={signOut}
      disabled={busy}
      aria-label="Sign out of admin"
      title="Sign out of admin"
      className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-primary/25 bg-primary/[0.08] text-primary transition-all duration-200 ease-out hover:bg-primary/15 disabled:opacity-50"
    >
      <span className="iconify h-4 w-4 ph--sign-out" aria-hidden="true" />
    </button>
  );
};
