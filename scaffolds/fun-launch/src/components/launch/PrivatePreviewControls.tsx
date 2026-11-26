import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  previewRequest,
  unlockPreview,
  type LaunchPreviewDraft,
  type PreviewInvite,
  type SavedPreview,
} from '@/lib/launchPreview';
import { SocialRequestError } from '@/lib/profiles';

type Props = {
  wallet?: string;
  signMessage?: (message: Uint8Array) => Promise<Uint8Array>;
  connect: () => void;
  draftFromForm: () => Promise<LaunchPreviewDraft>;
  restoreDraft: (draft: LaunchPreviewDraft) => void;
  canSave: boolean;
};

type OwnerState = { revision: number; invites: PreviewInvite[] };

const shortWallet = (value: string) => `${value.slice(0, 5)}…${value.slice(-5)}`;

export function PrivatePreviewControls({
  wallet,
  signMessage,
  connect,
  draftFromForm,
  restoreDraft,
  canSave,
}: Props) {
  const [saved, setSaved] = useState<OwnerState | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [link, setLink] = useState('');
  const [hours, setHours] = useState(24);
  const [viewer, setViewer] = useState('');
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);

  async function act(operation: (signal: AbortSignal) => Promise<void>) {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || busy) return;
    setBusy(true);
    setStatus('');
    try {
      await operation(signal);
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof SocialRequestError && error.status === 401) {
        setSaved(null);
        setLink('');
      }
      setStatus(error instanceof Error ? error.message : 'Private preview request failed.');
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }

  async function load(signal: AbortSignal, restore = false) {
    const data = await previewRequest<SavedPreview>(
      { action: 'load', includeDraft: restore },
      wallet,
      signal
    );
    signal.throwIfAborted();
    setSaved({ revision: data.revision, invites: data.invites });
    if (!restore) return;
    setLink('');
    if (data.draft) restoreDraft(data.draft);
    setStatus(data.draft ? 'Saved draft loaded into the launch form.' : 'No saved draft yet.');
  }

  return (
    <section
      id="private-launch-preview"
      className="surface scroll-mt-24 space-y-3 p-5"
      aria-label="Private launch preview"
      aria-busy={busy}
    >
      <div>
        <h2 className="font-term text-sm font-bold uppercase text-primary">
          Private launch preview
        </h2>
        <p className="mt-1 text-sm text-neutral-400">
          Save one encrypted draft per wallet. Share a read-only invite before you launch.
        </p>
      </div>
      {!saved ? (
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => {
            if (!wallet) return connect();
            void act(async (signal) => {
              try {
                await load(signal);
              } catch (error) {
                if (!(error instanceof SocialRequestError) || error.status !== 401) throw error;
                if (!signMessage) throw new Error('Connect a wallet that can sign messages.');
                await unlockPreview(wallet, signMessage, signal);
                await load(signal);
              }
            });
          }}
        >
          {wallet ? 'Unlock previews' : 'Connect wallet'}
        </Button>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={busy || !canSave}
              onClick={() =>
                void act(async (signal) => {
                  const draft = await draftFromForm();
                  const next = await previewRequest<{ revision: number }>(
                    { action: 'save', revision: saved.revision, draft },
                    wallet,
                    signal
                  );
                  signal.throwIfAborted();
                  setSaved({ revision: next.revision, invites: [] });
                  setLink('');
                  setStatus('Draft saved.');
                })
              }
            >
              Save draft
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => void act((signal) => load(signal, true))}
            >
              Load saved draft
            </Button>
          </div>
          {!canSave && (
            <p className="text-xs text-neutral-500">
              Add a valid name, ticker and artwork to save.
            </p>
          )}
          {saved.revision > 0 && (
            <div className="space-y-3 border-t border-neutral-800 pt-3">
              <p className="text-xs text-neutral-400">
                Invites open the saved draft. Saving again invalidates its earlier invites.
              </p>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                <label className="space-y-1 text-xs text-neutral-400">
                  <span>Invite expires in</span>
                  <select
                    className="block w-full rounded-md border border-neutral-800 bg-neutral-950 px-2 py-2 text-foreground"
                    value={hours}
                    onChange={(event) => setHours(Number(event.target.value))}
                  >
                    <option value={1}>1 hour</option>
                    <option value={24}>24 hours</option>
                    <option value={168}>7 days</option>
                  </select>
                </label>
                <label className="space-y-1 text-xs text-neutral-400">
                  <span>Invited wallet (optional)</span>
                  <input
                    className="block w-full rounded-md border border-neutral-800 bg-neutral-950 px-2 py-2 font-mono text-foreground"
                    value={viewer}
                    maxLength={44}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Wallet address"
                    onChange={(event) => setViewer(event.target.value)}
                  />
                </label>
              </div>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void act(async (signal) => {
                    const created = await previewRequest<{ invite: PreviewInvite; token: string }>(
                      {
                        action: 'invite',
                        revision: saved.revision,
                        hours,
                        viewerWallet: viewer.trim() || null,
                      },
                      wallet,
                      signal
                    );
                    signal.throwIfAborted();
                    setSaved({ ...saved, invites: [created.invite, ...saved.invites] });
                    setLink(`${window.location.origin}/launch-preview#${created.token}`);
                    setStatus('Invite created. Copy its link now.');
                  })
                }
              >
                Create invite
              </Button>
              {link && (
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    className="min-w-0 flex-1 rounded-md border border-neutral-800 bg-neutral-950 px-2 py-2 font-mono text-xs"
                    aria-label="Private invite link"
                    value={link}
                    readOnly
                    onFocus={(event) => event.target.select()}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(link);
                        setStatus('Invite link copied.');
                      } catch {
                        setStatus('Select and copy the invite link.');
                      }
                    }}
                  >
                    Copy link
                  </Button>
                </div>
              )}
              {saved.invites.length > 0 && (
                <ul
                  aria-label="Active invites"
                  className="max-h-44 divide-y divide-neutral-800 overflow-auto"
                >
                  {saved.invites.map((invite) => (
                    <li
                      className="flex items-center justify-between gap-2 py-1 text-xs"
                      key={invite.id}
                    >
                      <div className="min-w-0">
                        <p>
                          {invite.viewerWallet
                            ? shortWallet(invite.viewerWallet)
                            : 'Anyone with the link'}
                        </p>
                        <time dateTime={invite.expiresAt} className="text-neutral-500">
                          {new Date(invite.expiresAt).toLocaleString()}
                        </time>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          void act(async (signal) => {
                            await previewRequest(
                              { action: 'revoke', id: invite.id },
                              wallet,
                              signal
                            );
                            signal.throwIfAborted();
                            setLink('');
                            setSaved({
                              ...saved,
                              invites: saved.invites.filter(({ id }) => id !== invite.id),
                            });
                            setStatus('Invite revoked.');
                          })
                        }
                      >
                        Revoke
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
      {status && (
        <p role="status" className="break-words text-sm text-neutral-300">
          {status}
        </p>
      )}
    </section>
  );
}
