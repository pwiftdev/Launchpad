# Handoff: make MSKD.fun fully operational for a mainnet test

> **Update 2026-11-23 (owner decision, supersedes hSOL):** MSKD mode **pairs to SOL** like the other
> modes and **pays its 0.60% holder share in Monero (wXMR)**, with a planned option to cash out to
> real XMR. hSOL is dropped (another launchpad, rings.run, already owns the hSOL / Helius Rings
> story). Migration `026-mskd-sol-pair.sql` replaces 025's hSOL quote rule; all configs are SOL.

You are taking over a Solana memecoin launchpad called **MASKED / MSKD.fun**. Your goal is to get it
to the point where the owner can run a **small, controlled mainnet test** of all three launch modes,
end to end: launch, trade, bond (migrate), claim fees, pay out. Work on devnet first. Mainnet only
after the owner explicitly says "go mainnet".

## Hard rules (non-negotiable)

- **Devnet only** until the owner says "go mainnet" in chat. The code already fails closed on
  mainnet (RPC genesis checks in the launch/swap/relay APIs); do not weaken that to "test".
- **Never read, print, copy or commit secrets.** Do not open `.env` files. Do not echo keys,
  API keys, seed phrases or signer configs. Public addresses are fine.
- **Ask the owner first** before: spending mainnet SOL, turning `DRY_RUN` off anywhere, creating or
  changing any on-chain fee config (every fee change means a *new* config key), deleting files,
  or changing any signed message text.
- **Commit first.** The repo has ~470 uncommitted changes on `main` (the whole MSKD rebrand, modes,
  redesign). Before you change anything, ask the owner to let you create a branch (for example
  `mskd-rebrand`) and commit the current state, so your work is reviewable on top of it.
- Another agent may have worked in this repo in parallel. Re-read files right before editing them.
- Don't run prettier over all of `src` (it rewrites upstream line endings).

## Where things are

- Monorepo, pnpm via `corepack pnpm`. App: `scaffolds/fun-launch` (Next.js 15, pages router).
- Tests: `corepack pnpm --filter @meteora-invent/scaffold/fun-launch test` (vitest, currently 624
  passing) and `node --test scripts/*.test.cjs scripts/*.test.mjs` (one known failure:
  `standalone-smoke` needs a production build).
- Local preview config: `.claude/launch.json`, entry `fun-launch-demo`.
- Read these docs before planning: `docs/MAINNET-READINESS.md` (its "Required before enabling
  financial mainnet operations" table is the real blocker list), `docs/MAINNET-OWNER-DECISIONS.md`,
  `docs/FINANCIAL-OPERATIONS.md`, `docs/COIN-ECONOMICS.md`, `docs/CONFIG-AND-GRADUATION.md`,
  `docs/LIVE-DEPLOYMENT.md`, `docs/DEPLOYMENT.md`.
- Mainnet tooling already in `package.json`: `audit:launch-config`, `mainnet:prepare`,
  `deployment:check`, `operator:build`, `operator:check`, plus `scripts/production-preflight.mjs`,
  `scripts/mainnet-bootstrap.mjs`, `scripts/register-launch-config.mjs`, `scripts/validate-env.mjs`.

## The product (decided by the owner)

**Fee:** 99% in the launch slot only (one slot, anti-sniper; the creator's bundled first buy pays
1.25%), then a **flat 1.25% before and after bonding**. Split of every trade: **Meteora 0.25%,
house 0.40%, mode beneficiary 0.60%**. Post-bond 1.25% uses DBC `MigrationFeeOption.Customizable`
with `migratedPoolFeeBps: 125` on DAMM v2.

**Three modes** (single source of truth: `src/constants/modePolicy.json` + `src/lib/feeModes.ts`):

| Mode id | Policy version | Pair | 0.60% goes to |
|---|---|---|---|
| `mskd` | `mskd-v1` | SOL | Holders, pro rata, **paid in wXMR** (`WXMRyRZhsa19ety5erZhHg4N3xj3EVN92u94422teJp`, 12 decimals) |
| `dev` | `dev-v1` | SOL | The creator |
| `cashback` | `cashback-v1` | SOL | Holders, pro rata, paid in SOL |

Holder payouts exclude pools, LP, burn and house wallets. Optional dev first buy capped at 2% of
supply. 20% of supply migrates. Launch liquidity permanently locked. All partner fees are claimed by
the house wallet and routed off-chain by the ledger (that is the existing design:
`creatorTradingFeePercentage: 0`, partner LP 100% permanently locked).

## What already exists (phase 1, done)

- Mode definitions, split and display helpers, with tests (`src/lib/feeModes.test.ts`).
- Config builder and policy checker understand the modes: `scripts/wallet-launch-template.cjs`
  (`buildWalletLaunchTemplate({ policyVersion, quoteMint, migrationQuoteThreshold })`) and
  `scripts/launch-policy.cjs` (`inspectLaunchConfig`). MSKD mode refuses to build without a pinned
  quote mint and a reviewed bonding target. Tests in `scripts/wallet-launch-template.test.cjs`.
- Launch page has a mode picker (`src/components/launch/ModePicker.tsx`) and fee split display.
- `/api/launch/status?mode=mskd|dev|cashback` deliberately returns `canLaunch: false` for the new
  modes. **Only the old `bond-v1` ("Bond it.") policy can launch today.** The launch payload still
  sends `ACTIVE_LAUNCH_MODE` (`bond`), see the comment in `src/pages/launch.tsx`.
- Existing coins keep their original policy (`bond-v1`, `wallet-v1`, `rinse-v1`); don't relabel them.

## What you need to build (phase 2), in order

1. **Database.** New migration `scripts/migrations/025-mskd-modes.sql` (024 is the latest). Extend
   the `policy_version` and `mode` CHECK constraints on `launch_configs`, `launch_coins` and
   `pending_launch_intents` for `mskd-v1/dev-v1/cashback-v1` and `mskd/dev/cashback`, and update the
   `check_bond_launch_policy()` trigger (024) so mode ↔ policy pairs are enforced for the new modes.
   Keep the immutability triggers. Add whatever per-coin fields the payouts need (quote mint).
2. **Admission.** `src/server/launchConfig.ts` `verifyLaunchConfig` and `discoverableConfigKeys`,
   `src/lib/launchModes.ts`, `src/server/launchRegistry.ts`, `src/server/tradingAccess.ts`: accept
   the three new policies (activationType 0, quote mint per mode), keep `bond-v1` working for
   existing coins. Then make `/api/launch/status` report `canLaunch: true` only when a reviewed,
   registered config exists for that mode. Make the launch page send the *selected* mode and make the
   upload/prepare/confirm APIs and the signed launch message carry it.
3. **Fee routing (the big one).** `src/server/economics/*` (wallet store/worker/adapter, fee ledger,
   planning). Today the post-bond split is creator 62.5% / platform 37.5% and pre-bond is
   95% buyback / 5% ops for `bond-v1`. Add the mode policies: of collected non-protocol income,
   **60% to the beneficiary, 40% house** (`BENEFICIARY_NET_BPS = 6000` in `feeModes.ts`), both before
   and after bonding. Creator payouts can reuse the existing signed-message payout request
   (`src/components/coinpage/RewardsPanel.tsx`, `/api/rewards`).
4. **Holder payouts.** Not implemented anywhere yet (see the readiness table: "Holder snapshots"
   and "Claims"). Design and build: finalized owner-level balance snapshots per epoch, exclusions
   (DBC pool, DAMM pool/LP, burn, house wallets), deterministic pro-rata allocation, double-payout
   protection, a minimum payout with rollover, and verifiable receipts. Push payouts or signed claims
   are both acceptable; write the design down and get the owner's OK before building it.
5. **Monero payouts for MSKD mode.** Fees are claimed in SOL for every mode. For MSKD, convert each
   epoch's SOL holder budget to wXMR (`payoutMintFor('mskd', …)` in `src/lib/feeModes.ts`;
   devnet mock via `MSKD_DEVNET_PAYOUT_MINT`, 12 decimals) with bounded quote age and slippage, an
   idempotent swap job and a finalized receipt, then pay holders in wXMR (an SPL token: token
   accounts, rent paid by the house in SOL). Check real SOL→wXMR market depth first; the wXMR market
   has been thin. Phase 2 (owner wants it): optional **cash-out to native XMR** through the wXMR
   bridge's redemption (0.1% fee, 0.1 XMR minimum per wxmr.io), batched. Also decide (ask the
   owner) what happens to **base-token fees** from DAMM v2 after bonding.
6. **Devnet configs.** All three modes use SOL with the 80 SOL bonding target. Build them with the
   template, verify with `audit:launch-config`, register with `register-launch-config.mjs`. Ask
   before signing anything. For MSKD payouts on devnet, create a mock 12-decimal wXMR mint.
7. **Devnet end-to-end rehearsal for each mode:** launch (with and without dev buy), the 99% launch
   slot, trades, bonding/migration to DAMM v2 (`/api/launch/migrate`), fee claims pre- and
   post-bond, creator payout (dev), holder payouts (mskd, cashback), receipts. Record evidence in a
   new dated doc in `docs/`.
8. **Mainnet readiness.** Work through every row of the table in `docs/MAINNET-READINESS.md` and the
   "Remaining concrete setup" list in `docs/MAINNET-OWNER-DECISIONS.md`: company wallets and signer
   custody, operator host, production Postgres, Pinata, RPC, restore/alerting, security findings,
   final build. Then a *gated* mainnet plan: admin-only access (`LAUNCHPAD_PUBLIC` off), tiny
   amounts, one coin per mode, owner approval before each mainnet transaction.

## Also open (ask the owner, don't decide alone)

- The whitelist signature message still says `plzzz.bond` and promises `$PLZZZ`
  (`src/lib/whitelist.ts`). Changing a signed message needs a version bump and owner approval.
- X handle `@mskdfun` in `src/constants/brand.ts` is a placeholder. `BRAND.officialMint` is null.
- Anti-copy thresholds ($10k DexScreener liquidity, image distance 10) were never confirmed.
- Optional privacy work (owner is interested): Helius Solana Privacy Rings to hide payout amounts
  (Default Ring is audited; anonymous Custom Rings audits are due December 2026), no-log server,
  bring-your-own RPC. Not in scope until the owner prioritizes it.

## Done means

- Each mode launches on devnet from the UI, trades, bonds, and pays its 0.60% to the right party
  with receipts, verified by tests and a written devnet rehearsal record.
- `MAINNET-READINESS.md` rows are closed with evidence, or listed as accepted risks by the owner.
- A written mainnet test plan the owner approves before any mainnet transaction.
- All tests pass; nothing secret committed; work committed on a branch, not `main`.
