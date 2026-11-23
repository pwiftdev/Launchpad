# Bond it. backend policy

Local implementation of the owner's final economics and launch-slot protection. This work does not
deploy a configuration, migrate production data, change live environment variables, or send a
financial transaction. The launch form, branding copy and reward views are now integrated with this
policy; see [the current deployment guide](LIVE-DEPLOYMENT.md) for release checks and remaining live
infrastructure work.

## One new-launch policy

New uploads must explicitly sign `mode: "bond"` with `burnShare: 0`. The latter is a retained
authorization field, not a selectable burn percentage. A `bond-v1` registry entry and verified
configuration are required. Historical `wallet-v1` and native `rinse-v1` records retain their
original identity and fee accounting. They are not admitted for new launches.

| Destination                            | Normal curve trading | Graduated DAMM v2 trading |
| -------------------------------------- | -------------------: | ------------------------: |
| Total fee                              |                1.25% |                     1.00% |
| Buyback and burn budget                |                0.95% |                        0% |
| Platform, including operating expenses |                0.05% |                     0.30% |
| Original creator                       |                   0% |                     0.50% |
| Meteora protocol/referral allocation   |                0.25% |                     0.20% |

These figures assume the standard 20% protocol allocation. Actual collected quote income is split
95/5 before graduation, and 62.5/37.5 between creator and platform after graduation. Integer carry
is cumulative per phase, so batching cannot change the eventual entitlement. Source-program evidence
determines the phase: every DBC trade remains pre-bond regardless of elapsed time; DAMM trades are
post-bond. Unspent pre-bond buyback budgets survive graduation.

## Launch-slot fee

The single linear scheduler starts at 99%, has one period lasting one slot, and reduces by 97.75
percentage points to exactly 1.25%. DBC activation type is slot-based (`0`). Only the creator's
first buy bundled with pool creation uses Meteora's minimum-fee exemption. A later transaction by
that same wallet does not receive a permanent exemption. Dynamic fees remain disabled.

High-fee launch-slot income follows the same 95/5 split of non-protocol receipts. The old 27-second
90% exponential schedule is retained solely for historical coins. The 80 SOL target, immutable SPL
token settings, optional capped creator purchase and permanently locked launch liquidity remain as
configured previously. DAMM v2 migration uses timestamp activation internally, with a fixed 1% fee.

Registry `activation_point` is the birth slot for new coins. `activation_time` stores the verified
creation transaction's Unix timestamp for age and anti-vamp checks. Coin responses expose
`launchSlot`. `bondFeePercentAtSlot` is available for an accurate slot-based display; do not reuse
the historical 27-second countdown. The quote API already calculates fees from the actual slot and
pool configuration.

## Self-funding execution

The platform's earned share funds execution. Actual finalized transaction fees and account rent are
recorded once in append-only `wallet_operating_costs` and `wallet_operating_sources` records, and
charged only against unreserved platform balances of Bond it. coins sharing the collector. Creator,
community, historical-policy and buyback balances are not used to fund operations.

Treasury withdrawals retain a pooled 0.01 SOL working reserve plus pending execution estimates and
unrecovered costs. Collections wait until the operating allocation can cover the bounded execution
cost. Each unsigned preparation reserves operating capacity before signing. Failed transaction fees
remain recorded and are recovered from subsequent platform income. No extra creation charge is
added.

Solana still requires the fee payer to hold enough SOL before submitting the first collection or
creating temporary accounts. Retained fee income replenishes that working balance; the code does not
claim it can submit a transaction from a zero-balance account.

## Integration and release

- UI launch payload and `/api/launch/status` query use `bond`, labeled **Bond it.** There is no new
  Creator/Community selector. Historical reward views may still report their original modes.
- `/api/launch/status` reports normal, launch-slot and migrated fee rates, the one-slot window, and
  the bundled-buy exemption.
- Anti-vamp ticker, name, source-post, artwork and external-liquidity checks remain enabled before
  metadata upload. Unknown slot-launch timestamps conservatively retain ticker protection.
- The template generator defaults to `bond-v1`; its explicit `wallet-v1` option is for historical
  verification. Configuration registration and the active audit command target `bond-v1`.
- Apply migrations through `024-bond-it-policy.sql`. Startup migrations are reentrant, including
  when Bond it. records already exist. Configuration/coin policy and mode must match in the
  database.
- Prepare and verify a **new** Meteora configuration; the old live configuration cannot acquire
  these economics through a UI change. Keep its key discoverable for historical coins. Use the
  existing release gates and pin the new configuration digest and rebuilt operator artifacts before
  enabling it.

The existing settlement remains company-wallet-operated. These backend rules are not a claim of
immutable program-enforced routing: the company controls the collector's private signing authority.

## Verification

- Full application suite: 595 tests passed.
- Operational suite: 124 tests passed, including both economic policy versions and the generated
  schema contract.
- Workspace TypeScript check and ESLint for the changed TypeScript files passed.
- Standalone operator, scheduler and signer builds passed. Portable operator/startup checks passed
  with global module lookup disabled and without installed source dependencies. Smoke checks created
  no signatures and sent no transactions.
- Fee scheduling was checked with the installed Meteora SDK: activation slot returns numerator
  `990000000`, the next slot and later slots return `12500000`, and the migrated fee is 100 bps.
- Embedded PostgreSQL tests cover exact allocation, cumulative rounding, post-graduation carry,
  original-creator restrictions, operating expenses, failed collection recovery, treasury retention,
  legacy-mode rejection and repeated migrations with existing Bond it. records.

These are local checks and simulated financial evidence. A funded end-to-end acceptance run against
the new deployed configuration remains a release task.
