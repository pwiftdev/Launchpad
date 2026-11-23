import type { Coin, HoldersResponse } from '@/lib/coin';
import { displayShare, holderSupplyShare } from '@/lib/tokenActivity';
import { PanelSection } from './PanelSection';

type FairnessCardProps = {
  holders: HoldersResponse | undefined;
  coin: Coin;
};

/** Ownership concentration from the largest listed token accounts, grouped by owner. */
export const FairnessCard = ({ holders, coin }: FairnessCardProps) => {
  const list = holders?.holders ?? [];
  const supply = holders?.tokenSupply ?? coin.tokenSupply;
  const top10 =
    supply !== undefined && supply > 0
      ? list.slice(0, 10).reduce((a, h) => a + (holderSupplyShare(h, supply) ?? 0), 0)
      : null;
  const devAmount = list.filter((h) => h.isCreator).reduce((a, h) => a + h.amount, 0);
  const devShare = supply !== undefined && supply > 0 ? devAmount / supply : null;

  return (
    <PanelSection
      title="Ownership"
      aside={
        <span
          className="cursor-help text-[10px] text-neutral-500"
          title="Largest token accounts are grouped by owner. Balances outside this list may change these percentages. Shares use total current supply. Reward allocations use a separate complete snapshot."
        >
          Partial coverage <span className="iconify h-3 w-3 align-[-2px] ph--info" />
        </span>
      }
    >
      <dl className="space-y-3">
        <Metric
          label="Creator in listed accounts"
          value={holders ? displayShare(devShare) : '…'}
          share={devShare}
        />
        <Metric
          label="Top 10 listed owners"
          value={holders ? displayShare(top10) : '…'}
          share={top10}
        />
      </dl>
    </PanelSection>
  );
};

const Metric = ({
  label,
  value,
  share,
}: {
  label: string;
  value: string;
  share: number | null;
}) => (
  <div>
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <dt className="text-neutral-400">{label}</dt>
      <dd className="font-mono tabular-nums text-neutral-100">{value}</dd>
    </div>
    <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-neutral-850" aria-hidden>
      <div
        className="h-full rounded-full bg-primary/70"
        style={{ width: `${Math.min(Math.max(share ?? 0, 0), 1) * 100}%` }}
      />
    </div>
  </div>
);
