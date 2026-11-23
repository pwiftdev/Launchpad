import bondPolicy from '@/constants/bondPolicy.json';

/** The schedule uses slots, so a seconds-based curve would be misleading. */
export const TaxChart = () => (
  <figure>
    <dl className="grid grid-cols-3 gap-3 text-center">
      {[
        ['Launch slot', bondPolicy.startingFeeBps / 100],
        ['Next slot onward', bondPolicy.endingFeeBps / 100],
        ['After bonding', bondPolicy.migrationFeeBps / 100],
      ].map(([label, percent]) => (
        <div key={label} className="surface p-4">
          <dt className="text-xs text-neutral-400">{label}</dt>
          <dd className="mt-2 font-mono text-xl font-bold">{percent}%</dd>
        </div>
      ))}
    </dl>
    <figcaption className="mt-3 text-xs leading-relaxed text-neutral-500">
      Applies to buys and sells. Only the creator’s first buy bundled with creation pays 1.25%
      during the launch slot. Check the live quote before signing.
    </figcaption>
  </figure>
);
