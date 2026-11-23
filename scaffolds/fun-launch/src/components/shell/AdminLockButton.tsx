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
      className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-primary/25 bg-primary/5 text-primary transition-colors hover:bg-primary/10 disabled:opacity-50"
    >
      <span className="iconify h-4 w-4 ph--sign-out" aria-hidden="true" />
    </button>
  );
};
