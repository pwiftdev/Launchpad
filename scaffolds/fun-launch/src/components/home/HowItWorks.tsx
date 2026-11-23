import Link from 'next/link';
const STEPS = [
  {
    icon: 'ph--shield-check-fill',
    color: 'text-rose bg-rose/10',
    title: 'One-slot launch guard',
    body: "99% in the launch slot, then 1.25% on the curve. The creator's first buy bundled with creation pays 1.25%.",
  },
  {
    icon: 'ph--hand-coins-fill',
    color: 'text-primary bg-primary/10',
    title: 'Buy back and burn',
    body: 'Normal curve fees allocate 0.95% to same-token buybacks and burns, 0.05% to operations, and 0.25% to Meteora.',
  },
  {
    icon: 'ph--sparkle-fill',
    color: 'text-emerald bg-emerald/10',
    title: 'Bond it.',
    body: 'After bonding, trading costs 1%: 0.50% for the original creator, 0.30% for the platform, and 0.20% for Meteora.',
  },
] as const;

export const HowItWorks = () => (
  <section aria-labelledby="how-it-works" className="mt-10">
    <div className="flex items-end justify-between gap-4">
      <h2
        id="how-it-works"
        className="font-display text-2xl font-black uppercase tracking-tight md:text-3xl"
      >
        How Bond it. works
      </h2>
      <Link href="/rules" className="text-sm font-semibold text-primary hover:underline">
        Read the full rules
      </Link>
    </div>
    <ol className="mt-5 grid gap-4 md:grid-cols-3">
      {STEPS.map((step, i) => (
        <li key={step.title} className="surface relative p-5">
          <span className="absolute right-5 top-4 font-display text-5xl font-black text-neutral-850">
            {i + 1}
          </span>
          <span
            className={`inline-flex h-11 w-11 items-center justify-center rounded-xl ${step.color}`}
          >
            <span className={`iconify h-6 w-6 ${step.icon}`} />
          </span>
          <h3 className="mt-4 text-lg font-bold">{step.title}</h3>
          <p className="mt-1.5 text-sm leading-relaxed text-neutral-400">{step.body}</p>
        </li>
      ))}
    </ol>
  </section>
);
