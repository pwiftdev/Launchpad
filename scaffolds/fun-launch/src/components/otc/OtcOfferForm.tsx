import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  OTC_ASSETS,
  OTC_EXPIRIES,
  normalizeOtcAmount,
  oppositeOtcAsset,
  type OtcAsset,
  type OtcExpiry,
  type OtcLeg,
  type OtcToken,
  type OtcTerms,
} from '@/lib/otc';
import { cn } from '@/lib/utils';
import {
  OtcFeedback,
  OtcIcon,
  OtcPanelHead,
  OtcPulse,
  otcFeature,
  otcField,
  otcLabel,
} from './OtcLayout';
import { OtcAssetMark } from './OtcTermsCard';
import { OtcTokenPicker } from './OtcTokenPicker';

export type OtcOfferDraft = { terms: OtcTerms; minutes: OtcExpiry; viewerWallet: string | null };
const offerLeg = (asset: OtcAsset | OtcToken, amount: string): OtcLeg =>
  typeof asset === 'string' ? { asset, amount } : { asset: 'TOKEN', amount, token: asset };

export function OtcOfferForm({
  busy,
  onCreate,
  invitation,
  agreement,
  onOpenDeal,
  onCopy,
  onNew,
  error,
  notice,
  tokenWallet,
}: {
  busy: boolean;
  onCreate: (draft: OtcOfferDraft) => void;
  invitation?: string;
  agreement: 'waiting' | 'accepted' | 'unavailable';
  onOpenDeal?: () => void;
  onCopy: () => void;
  onNew: () => void;
  error: string;
  notice: string;
  tokenWallet?: string;
}) {
  const [sell, setSell] = useState<OtcAsset>('SOL');
  const [sellValue, setSellValue] = useState('');
  const [buyValue, setBuyValue] = useState('');
  const [minutes, setMinutes] = useState<OtcExpiry>(60);
  const [viewerWallet, setViewerWallet] = useState('');
  const [custom, setCustom] = useState(false);
  const [token, setToken] = useState<OtcToken>();
  const [quote, setQuote] = useState<OtcAsset>('SOL');
  const [sendToken, setSendToken] = useState(true);
  const sellAsset = custom ? (sendToken ? token : quote) : sell;
  const buyAsset = custom ? (sendToken ? quote : token) : oppositeOtcAsset(sell);
  const sellAmount = sellAsset && normalizeOtcAmount(sellAsset, sellValue);
  const buyAmount = buyAsset && normalizeOtcAmount(buyAsset, buyValue);
  const viewerId = useId();
  const linkId = useId();
  function switchAmounts() {
    setSellValue(buyValue);
    setBuyValue(sellValue);
  }

  function flip() {
    if (custom) setSendToken((value) => !value);
    else setSell(oppositeOtcAsset(sell));
    switchAmounts();
  }
  const symbolOf = (asset: OtcAsset | OtcToken) =>
    typeof asset === 'string' ? asset : asset.symbol;
  const price =
    sellAsset && buyAsset && sellAmount && buyAmount
      ? impliedPrice(symbolOf(sellAsset), sellAmount, symbolOf(buyAsset), buyAmount)
      : undefined;

  if (invitation)
    return (
      <section className={cn(otcFeature, 'space-y-6 p-5 sm:p-8')} aria-busy={busy}>
        <OtcPanelHead eyebrow="Offer created" title="Share your private link" icon="ph--link">
          Share this link with your counterparty so they can review and sign the terms.
        </OtcPanelHead>
        <div className="space-y-2">
          <label htmlFor={linkId} className={cn(otcLabel, 'block')}>
            Private offer link
          </label>
          <div className="flex min-w-0">
            <input
              id={linkId}
              className={cn(otcField, 'border-r-0 font-code text-xs text-neutral-300')}
              value={invitation}
              readOnly
              onFocus={(event) => event.target.select()}
            />
            <Button
              type="button"
              size="lg"
              variant="holo"
              className="h-11 shrink-0 px-4"
              onClick={onCopy}
              disabled={agreement === 'unavailable'}
            >
              <OtcIcon name="ph--copy" className="h-4 w-4" />
              Copy
            </Button>
          </div>
        </div>
        <div
          className={cn(
            'flex flex-wrap items-center justify-between gap-3 border px-4 py-3.5',
            agreement === 'accepted'
              ? 'border-emerald/30 bg-emerald/[0.05]'
              : 'border-neutral-800 bg-neutral-950'
          )}
        >
          <span role="status" className="flex items-center gap-3 text-sm">
            {agreement === 'accepted' ? (
              <OtcIcon name="ph--check-circle" className="h-5 w-5 text-emerald" />
            ) : agreement === 'waiting' ? (
              <OtcPulse className="mx-1" />
            ) : (
              <OtcIcon name="ph--x-circle" className="h-5 w-5 text-neutral-500" />
            )}
            <span>
              <span className="block font-medium text-foreground">
                {agreement === 'accepted'
                  ? 'Agreement signed'
                  : agreement === 'waiting'
                    ? 'Waiting for your counterparty'
                    : 'Offer no longer available'}
              </span>
              <span className="block text-xs text-neutral-400">
                {agreement === 'accepted'
                  ? onOpenDeal
                    ? 'Open the deal to fund your side.'
                    : 'Both sides now have a signed record of the terms.'
                  : agreement === 'waiting'
                    ? 'This updates on its own once they sign.'
                    : 'It expired or was revoked.'}
              </span>
            </span>
          </span>
          {onOpenDeal && (
            <Button type="button" variant="holo" onClick={onOpenDeal}>
              Open deal <OtcIcon name="ph--arrow-right" className="h-4 w-4" />
            </Button>
          )}
        </div>
        <OtcFeedback error={error} notice={notice} />
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-neutral-850 pt-5">
          <p className="text-xs text-neutral-500">
            Track or revoke it any time from <span className="text-neutral-300">My offers</span>.
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setSellValue('');
              setBuyValue('');
              setViewerWallet('');
              onNew();
            }}
          >
            <OtcIcon name="ph--plus" className="h-4 w-4" /> Create another
          </Button>
        </div>
      </section>
    );

  return (
    <form
      className={cn(otcFeature, 'space-y-6 p-5 sm:p-8')}
      aria-busy={busy}
      onSubmit={(event) => {
        event.preventDefault();
        if (sellAsset && buyAsset && sellAmount && buyAmount)
          onCreate({
            terms: {
              sell: offerLeg(sellAsset, sellAmount),
              buy: offerLeg(buyAsset, buyAmount),
            },
            minutes,
            viewerWallet: viewerWallet.trim() || null,
          });
      }}
    >
      <OtcPanelHead eyebrow="New offer" title="Name your price">
        Type the exact amount each side trades. Those two numbers are the price, and they can’t
        change after your counterparty signs.
      </OtcPanelHead>
      {tokenWallet && (
        <fieldset className="space-y-2" disabled={busy}>
          <legend className={cn(otcLabel, 'mb-2')}>Market</legend>
          <div className="grid grid-cols-2 gap-2">
            {([false, true] as const).map((value) => (
              <PairOption
                key={String(value)}
                name="otc-market"
                selected={custom === value}
                label={value ? 'Launchpad token' : 'SOL / USDC'}
                onSelect={() => {
                  setCustom(value);
                  setSellValue('');
                  setBuyValue('');
                }}
              />
            ))}
          </div>
        </fieldset>
      )}
      {custom && tokenWallet ? (
        <>
          <OtcTokenPicker
            wallet={tokenWallet}
            selected={token}
            disabled={busy}
            onSelect={(selected) => {
              setToken(selected);
              if (sendToken) setSellValue('');
              else setBuyValue('');
            }}
          />
          <fieldset disabled={busy || !token} className="space-y-2">
            <legend className={cn(otcLabel, 'mb-2')}>Pair with</legend>
            <div className="grid grid-cols-2 gap-2">
              {OTC_ASSETS.map((asset) => (
                <PairOption
                  key={asset}
                  name="otc-quote"
                  selected={quote === asset}
                  label={asset}
                  icon={asset}
                  onSelect={() => {
                    setQuote(asset);
                    if (sendToken) setBuyValue('');
                    else setSellValue('');
                  }}
                />
              ))}
            </div>
          </fieldset>
          <fieldset disabled={busy || !token} className="space-y-2">
            <legend className={cn(otcLabel, 'mb-2')}>Asset you send</legend>
            <div className="grid grid-cols-2 gap-2">
              <PairOption
                name="otc-direction"
                selected={sendToken}
                label={token?.symbol ?? 'Launchpad token'}
                icon="TOKEN"
                onSelect={() => {
                  setSendToken(true);
                  switchAmounts();
                }}
              />
              <PairOption
                name="otc-direction"
                selected={!sendToken}
                label={quote}
                icon={quote}
                onSelect={() => {
                  setSendToken(false);
                  switchAmounts();
                }}
              />
            </div>
          </fieldset>
        </>
      ) : (
        <fieldset disabled={busy} className="space-y-2">
          <legend className={cn(otcLabel, 'mb-2')}>Asset you send</legend>
          <div className="grid grid-cols-2 gap-2">
            {OTC_ASSETS.map((asset) => (
              <PairOption
                key={asset}
                name="otc-sell-asset"
                selected={sell === asset}
                label={asset}
                icon={asset}
                onSelect={() => {
                  setSell(asset);
                  switchAmounts();
                }}
              />
            ))}
          </div>
        </fieldset>
      )}
      {sellAsset && buyAsset && (
        <div>
          <div className="relative">
            <AmountField
              label="You send"
              asset={sellAsset}
              value={sellValue}
              valid={!!sellAmount}
              update={setSellValue}
              disabled={busy}
            />
            <div className="relative z-10 flex h-1.5 items-center justify-center">
              <button
                type="button"
                onClick={flip}
                disabled={busy}
                aria-label="Swap the assets you send and receive"
                className="flex h-9 w-9 items-center justify-center border border-neutral-700 bg-panel text-neutral-300 transition-colors hover:border-primary hover:text-primary disabled:opacity-50"
              >
                <OtcIcon name="ph--arrows-down-up" className="h-4 w-4" />
              </button>
            </div>
            <AmountField
              label="You receive"
              asset={buyAsset}
              value={buyValue}
              valid={!!buyAmount}
              update={setBuyValue}
              disabled={busy}
            />
          </div>
          <p
            aria-live="polite"
            className="mt-3 flex flex-wrap items-center justify-between gap-2 font-term text-[10px] uppercase tracking-[0.12em] text-neutral-500"
          >
            <span>Implied price</span>
            <span className="font-mono text-xs normal-case tracking-normal text-neutral-200">
              {price ?? '—'}
            </span>
          </p>
        </div>
      )}
      <div className="grid gap-4 border-t border-neutral-850 pt-6 sm:grid-cols-[minmax(0,0.6fr)_minmax(0,1fr)]">
        <fieldset disabled={busy} className="min-w-0">
          <legend className={cn(otcLabel, 'mb-2')}>Expires in</legend>
          <div className="grid grid-cols-3 border border-neutral-800">
            {(Object.entries(OTC_EXPIRIES) as [string, string][]).map(([value, label]) => (
              <label
                key={value}
                className="relative min-w-0 border-l border-neutral-800 first:border-l-0"
              >
                <input
                  type="radio"
                  name="otc-expiry"
                  className="peer sr-only"
                  checked={minutes === Number(value)}
                  onChange={() => setMinutes(Number(value) as OtcExpiry)}
                />
                <span
                  title={label}
                  className="flex h-11 cursor-pointer items-center justify-center bg-neutral-950 font-term text-[11px] uppercase tracking-[0.08em] text-neutral-400 transition-colors hover:text-foreground peer-checked:bg-primary/10 peer-checked:text-primary peer-focus-visible:ring-2 peer-focus-visible:ring-inset peer-focus-visible:ring-primary"
                >
                  {label.replace(' minutes', 'm').replace(' hours', 'h').replace(' hour', 'h')}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <label className="block min-w-0">
          <span className={cn(otcLabel, 'mb-2 flex items-center justify-between gap-2')}>
            Invited wallet
            <span className="normal-case tracking-normal text-neutral-600">Optional</span>
          </span>
          <input
            className={cn(otcField, 'font-code text-xs')}
            autoComplete="off"
            spellCheck={false}
            maxLength={44}
            placeholder="Solana wallet address"
            value={viewerWallet}
            onChange={(event) => setViewerWallet(event.target.value)}
            disabled={busy}
            aria-describedby={viewerId}
          />
          <span id={viewerId} className="mt-2 block text-xs leading-relaxed text-neutral-500">
            {viewerWallet.trim()
              ? 'Only this wallet can open the link and agree.'
              : 'Leave blank to let anyone with the link review and agree.'}
          </span>
        </label>
      </div>
      <OtcFeedback error={error} notice={notice} />
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <Button type="submit" size="lg" variant="holo" disabled={busy || !sellAmount || !buyAmount}>
          {busy ? 'Creating link…' : 'Create offer link'}
          <OtcIcon name="ph--arrow-right" className="h-4 w-4" />
        </Button>
        <p className="flex items-center gap-1.5 text-xs text-neutral-500">
          <OtcIcon name="ph--shield-check" className="h-3.5 w-3.5 text-neutral-500" />
          Creating an offer doesn’t move funds.
        </p>
      </div>
    </form>
  );
}

/** "1 SOL = 142.5 USDC", for display only; the agreed terms are the two exact amounts. */
function impliedPrice(sendSymbol: string, send: string, receiveSymbol: string, receive: string) {
  const ratio = Number(receive) / Number(send);
  if (!Number.isFinite(ratio) || ratio <= 0) return undefined;
  const format = (value: number) =>
    value.toLocaleString(undefined, {
      maximumSignificantDigits: value >= 1 ? 8 : 6,
    });
  return ratio >= 1
    ? `1 ${sendSymbol} = ${format(ratio)} ${receiveSymbol}`
    : `1 ${receiveSymbol} = ${format(1 / ratio)} ${sendSymbol}`;
}

function PairOption({
  name,
  selected,
  label,
  icon,
  onSelect,
}: {
  name: string;
  selected: boolean;
  label: string;
  icon?: OtcLeg['asset'];
  onSelect: () => void;
}) {
  return (
    <label className="relative min-w-0">
      <input
        type="radio"
        className="peer sr-only"
        name={name}
        checked={selected}
        onChange={onSelect}
      />
      <span className="flex min-h-11 cursor-pointer items-center gap-2 border border-neutral-800 bg-neutral-950 px-3 text-sm font-medium text-neutral-300 transition-colors hover:border-neutral-700 hover:text-foreground peer-checked:border-primary/60 peer-checked:bg-primary/[0.08] peer-checked:text-foreground peer-focus-visible:ring-2 peer-focus-visible:ring-primary peer-disabled:opacity-50">
        {icon && <OtcAssetMark asset={icon} className="h-6 w-6 text-xs" />}
        <span className="truncate">{label}</span>
        {selected && <OtcIcon name="ph--check" className="ml-auto h-4 w-4 text-primary" />}
      </span>
    </label>
  );
}

function AmountField({
  label,
  asset,
  value,
  valid,
  update,
  disabled,
}: {
  label: string;
  asset: OtcAsset | OtcToken;
  value: string;
  valid: boolean;
  update: (value: string) => void;
  disabled: boolean;
}) {
  const invalid = !!value && !valid;
  const errorId = useId();
  const symbol = typeof asset === 'string' ? asset : asset.symbol;
  const precision = typeof asset === 'string' ? (asset === 'SOL' ? 9 : 6) : asset.decimals;
  return (
    <label
      className={cn(
        'block min-w-0 border bg-neutral-950 px-4 pb-3.5 pt-3 transition-colors focus-within:border-primary',
        invalid ? 'border-rose/50' : 'border-neutral-800 hover:border-neutral-700'
      )}
    >
      <span className={cn(otcLabel, 'block')}>{label}</span>
      <span className="mt-1.5 flex items-center gap-3">
        <input
          aria-label={`${label} in ${symbol}`}
          className="h-11 w-full min-w-0 bg-transparent font-mono text-[26px] font-semibold tracking-tight text-foreground placeholder:text-neutral-700 focus:outline-none sm:text-[30px]"
          value={value}
          onChange={(event) => update(event.target.value)}
          inputMode="decimal"
          placeholder="0.00"
          maxLength={30}
          required
          disabled={disabled}
          aria-invalid={invalid}
          aria-describedby={invalid ? errorId : undefined}
        />
        <span
          aria-hidden="true"
          className="flex shrink-0 items-center gap-1.5 border border-neutral-800 bg-panel px-2 py-1.5 text-xs font-semibold text-neutral-200"
        >
          <OtcAssetMark
            asset={typeof asset === 'string' ? asset : 'TOKEN'}
            className="h-5 w-5 text-[11px]"
          />
          <span className="max-w-[7rem] truncate">{symbol}</span>
        </span>
      </span>
      {invalid && (
        <span id={errorId} className="mt-1.5 block text-xs text-rose">
          Enter a positive {symbol} amount with up to {precision} decimal places.
        </span>
      )}
    </label>
  );
}
