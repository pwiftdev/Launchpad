# Mainnet launch fee audit — 29 October 2026

Later on the same date,
[automatic treasury withdrawals and image recovery](AUTOMATIC-TREASURY-AND-ARTWORK-2026-10-29.md)
were deployed at the owner's request. The balances and explicit-withdrawal behavior below describe
the earlier audit snapshot; the initial automatic treasury batch has since paid those platform
balances.

The observed fee routing, creator claims and atomic buyback/burn transactions reconcile correctly
for TESTDROP, HEARTDROP and CURSED. A separate display error in the Burns feed was found and
corrected: wallet buybacks must report finalized actual spending, rather than their maximum budgets.

## Scope and evidence

- Read the current Heroku configuration, operator state and production database over verified TLS
  with database writes disabled for the audit.
- Independently discovered all three pools using the production DBC configuration. Every pool is
  registered; no additional or missing launch was found for this configuration.
- Scanned finalized history back to each creation transaction: 62 successful pool transactions, one
  failed transaction, and 42 economic swap events. All recorded fee events match the chain.
- Independently verified all 33 settlement transactions: 20 collections, 11 buyback/burns and two
  creator claims. Receipt identity, destination, cash movements and burned amounts match.
- Recomputed the allocation from cumulative fee events and reconciled every funded/spent balance.
  The burn totals exactly explain the reduction from each original one-billion-token supply.
- Verified mint and freeze authorities are absent for all three tokens, the live DBC configuration
  matches its registered digest, and no launchpad-owned quote fees remain uncollected in these
  pools.
- The audit did not sign or broadcast any financial transaction. The already enabled private
  operator continued to run normally.

Raw evidence is retained under ignored `.local/real-chain-audit.private.json`,
`.local/real-history-audit.private.json`, `.local/real-launch-discovery.private.json` and
`.local/private-worker-v1-health.private.json`. Figures below describe the finalized audit snapshot;
later trades and claims can change them.

## Where fees go

Production config: `3FPuMxbaagtAn45zvufthsLkZnSenTPta7nuY7ZVshsE`.

| Role           | Address                                        | Observed behavior                                                                                            |
| -------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Fee collector  | `5iskTyXpKn7HeqvNUFBFc1rv2C2EoFNBNyFmXgGFztgS` | Receives collected launchpad fees; funds buybacks and approved claims.                                       |
| Treasury       | `GfgpgQa2ZqNm17rJ6fw2t5nBApKKPZBn5M5niWW3riZZ` | Fixed platform-withdrawal destination and configured leftover receiver. No platform withdrawal has executed. |
| CURSED creator | `4oBMoybH65umQ5hQetum676zDKY5ZdVRT23ijMZv2G6V` | Received the verified CURSED creator claim.                                                                  |

The allocation applies to actual launchpad fee income after protocol and swap-referral fees:

| Phase              | Buyback/burn | Creator or Community | Platform |
| ------------------ | -----------: | -------------------: | -------: |
| Initial 27 seconds |          80% |                   0% |      20% |
| After 27 seconds   |           0% |                  50% |      50% |

All three real launches selected Creator mode. Their post-RINSE allocation goes to their registered
creator, so zero Community balances and no holder epochs are expected. These launches do not
continuously fund buybacks from post-RINSE fees.

Protocol fees remain accrued in each pool for the DBC protocol. Referral fees were transferred to
the referral token accounts supplied by particular swap transactions; the full transfer total
matches the recorded referral fees. Those fees are distinct from website signup referrals. The
launchpad's own swap builder supplies no swap-referral account. The audit establishes the on-chain
recipient accounts, without claiming the real-world identities of their owners.

The DBC configuration's direct creator trading-fee percentage is zero by design: the launchpad
collects the partner fee and its wallet settlement ledger allocates the creator's share. The
successful CURSED creator payout confirms that this route is functioning.

## CURSED

Mint: `5gCeEXhQxBTJZUzYzfSdyX98QyBQe8q7ZfjV3rkxpYNi`.

| Fee flow                                            |         SOL |
| --------------------------------------------------- | ----------: |
| Total observed swap fees                            | 0.145556950 |
| Protocol fees retained in the DBC pool              | 0.023764760 |
| Swap-referral fees transferred to referral accounts | 0.005346623 |
| Launchpad income collected                          | 0.116445567 |
| Buyback spending, three finalized transactions      | 0.000202812 |
| Creator allocation earned                           | 0.058096026 |
| Creator allocation already claimed                  | 0.054457413 |
| Creator allocation still claimable                  | 0.003638613 |
| Platform allocation awaiting treasury withdrawal    | 0.058146729 |

Exactly **7,081.831700 CURSED** were bought and burned. Current supply at the snapshot was
**999,992,918.168300 CURSED**. Each burn occurred in the same transaction as its purchase.

Receipts:

- [First CURSED buyback/burn](https://solscan.io/tx/4auGE9BpSikqqNmsPVKFKEhVMEWmFHr4hxNYcfxnQeJhN9XcsVfYKVTTHaVX4z6KP2jTr54ZCG3Em97qUdUgz21i).
- [CURSED creator payout](https://solscan.io/tx/4mQYnWNcrdgx46uP26ZbP7Ti8T6ctTyKeNP7FXEaxgz6oc2tbMH5kELwSSJcrN4NkHsxtgxdsNyufS4Fvi3c4UCS).

## All launches

| Token     | Collected income (SOL) | Actual buyback spend (SOL) |  Tokens burned | Creator still claimable (SOL) | Platform awaiting withdrawal (SOL) |
| --------- | ---------------------: | -------------------------: | -------------: | ----------------------------: | ---------------------------------: |
| TESTDROP  |            0.020930739 |                0.000202812 |   7,991.132823 |                   0.010338612 |                        0.010389315 |
| HEARTDROP |            0.018862366 |                0.008400148 | 331,079.076962 |                   0.001238044 |                        0.006281128 |
| CURSED    |            0.116445567 |                0.000202812 |   7,081.831700 |                   0.003638613 |                        0.058146729 |

All buyback budgets are spent and there are no unsettled jobs or reserved balances. Combined
platform income of **0.074817172 SOL** remains in the collector, pending an explicit treasury
withdrawal. It has not been sent to the treasury automatically. Creator withdrawals require a claim.
HEARTDROP's creator is also the collector; its verified self-claim clears the creator entitlement
without a net SOL transfer to a separate wallet.

The collector held **0.489492099 SOL**, covering **0.090032441 SOL** in outstanding allocations and
leaving **0.399459658 SOL** beyond those obligations. The treasury held **0.001000000 SOL**. Network
fees come from operating capital and were not charged against creator allocations.

## Findings and limits

1. **Burn feed spending corrected.** The feed previously summed `wallet_jobs.lamports`, which is the
   maximum permitted spend. Across these 11 buybacks it displayed 0.008894741 SOL instead of the
   actual 0.008805772 SOL. It now requires matching finalized settlement facts and uses
   `wallet_settlements.actual_spent_lamports`. Burn counts and token amounts were already correct. A
   regression test covers spending below the maximum, duplicate sources and missing/mismatched
   settlement facts. No financial balances, destinations or spending policy were changed.
2. **Tiny operations are inefficient.** For example, the last CURSED buyback spent 20 lamports and
   paid a 5,000-lamport network fee. Several collections also process very small residuals. A
   minimum collection/buyback amount or fee-to-spend limit would reduce operating costs. No such
   policy change was activated during this review; accrued balances must remain available.
3. **Treasury withdrawals are explicit.** The automatic scheduler collects fees and processes
   buybacks/approved creator claims. It does not automatically queue platform withdrawals.
4. **Unexercised live paths.** None of these pools has graduated, and all use Creator mode. These
   receipts therefore establish the live DBC/Creator path, not an executed mainnet DAMM migration or
   Community holder distribution.
5. **Custody remains wallet-operated.** These launches use `wallet-v1`; outstanding allocations
   share the company's collector wallet. The observed worker is healthy and funded, and its signing
   key is confined to the private operator app. This is not native on-chain escrow.

## Deployment and validation

The owner's metadata/chart updates were deployed through Heroku's Source/Build API as release v42
before restarting the web dyno. Existing Git staging and working-tree changes were preserved. The
independent operator app remained running throughout.

- Baseline: 112 app test files, 567 tests passed; TypeScript passed.
- Burn-feed fix: all three receipt tests passed; TypeScript, targeted ESLint and formatting passed.
- Full-app ESLint: zero errors, 29 warnings.
- Initial live release: all 15 read-only HTTP checks passed, including CURSED trades, holders,
  buy/sell quotes, creator rewards and the burn feed.
- Final release **v43** is live at <https://rinsed.fun>, with one web dyno. Its source SHA-256 is
  `773ded64964566870d05856c26aed8b87ced11ed9411de71dbc031309395c85d`; Heroku build
  `b9177b39-4026-415e-9433-4f1f05f0c4de` succeeded. Configuration and the private operator release
  were unchanged. Comparison with the owner's initial deployed snapshot confirms the only production
  source file changed by the fix is `src/server/burnReceipts.ts`.
- All 17 final read-only HTTP checks passed. Every live burn receipt matches independently verified
  actual spending and token burns; the total is **0.008805772 SOL**, across 11 buybacks and three
  coins. Both launch modes remain enabled, and CURSED rewards show the verified paid and
  still-claimable amounts. The operator's closing cycle completed all three coins with no failures.
  An initial check timed out around the release restart; the subsequent complete check passed.
