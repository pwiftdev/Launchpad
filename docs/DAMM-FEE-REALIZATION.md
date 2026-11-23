# DAMM position income and integer settlement

This is operator/accounting documentation. It does not change launch policy or public copy.

## Actual claim arithmetic

Let `Q = 2^128`, `P` be our permanent position liquidity, `L_i` the pool liquidity at swap `i`, and
`f_i` its executed SOL LP fee, excluding protocol/referral fees. Stock CPAMM updates pool fee growth
by `g_i = floor(f_i * Q / L_i)`. At a position checkpoint it adds
`floor(P * (growth - checkpoint) / Q)` to the pending amount, then a claim transfers the pending
amount and updates the checkpoint. Growth subtraction wraps modulo `2^256`.

These rules are in the upstream
[pool fee-growth update](https://github.com/MeteoraAg/cp-amm/blob/main/programs/cp-amm/src/state/pool.rs)
and
[position fee update](https://github.com/MeteoraAg/cp-amm/blob/main/programs/cp-amm/src/state/position.rs).
The installed CPAMM SDK's `getUnClaimLpFee` uses the same Q128 position calculation. Replaying the
rules must match actual finalized pool growth, position checkpoint, pending fees, total claimed fees
and pool LP-fee metrics before the application issues a realization proof.

Two actual 2,000,000-lamport LP-fee events in the local rehearsal transferred 3,999,999 lamports
when claimed together. Crediting 4,000,000 would invent one lamport. The immutable raw observations
are retained; only actual owned cash may fund program budgets.

## Stable cash assignment

Within each actual claim window define a swap's cash as:

`cash_i = floor(P * prefixGrowth_i / Q) - floor(P * prefixGrowth_(i-1) / Q)`.

This keeps fractional carry until the position's actual checkpoint. It is not a per-swap floor of
the ideal proportional share. With `P <= L_i`, each delta is between zero and that swap's raw LP
fee. Later swaps cannot change an earlier delta. Exact signature/instruction/event identities bind
selected raw rows to these prefix deltas, so the same raw event cannot be funded twice.

The actual rehearsal funded the second event at 2,000,000 and later recovered the first event at
1,999,999. No old receipt or raw observation was rewritten, and no extra trade was used to hide the
last lamport. A zero-cash prefix is also possible: it needs normalization/audit records, not a fake
one-lamport funding transaction.

## Outside liquidity

The original migration position is permanently owned by the native fee-authority PDA. This does not
mean that it owns every future LP share. Stock CPAMM allows new liquidity while trading is enabled;
the same enable flag controls both actions. There is no supported LP-only disable switch in the
inspected
[permissionless access implementation](https://github.com/MeteoraAg/cp-amm/blob/main/programs/cp-amm/src/pool_action_access/permissionless.rs).

Proof replay starts from the actual migration initialization and processes every successful
`EvtLiquidityChange` (add/remove), swap and own-position claim in canonical block/instruction order.
It supports legitimate outside LP additions/removals instead of permanently refusing all fees after
an addition. Reporting uses the protocol's actual Q128 growth, with a fixed denominator.

For each closed claim window, the reporting convention is:

- External LP exclusion: `floor(sum((L_i - P) * g_i) / Q)` for that actual claim window.
- Rounding: remaining raw fees after that exclusion and our actual position cash.
- Conservation: raw LP fees = external exclusion + rounding + realized position cash.

This measures non-owned protocol fee growth; it does not claim that other wallets have actually
withdrawn that amount. Pool growth truncation and indivisible terminal fractions remain in rounding.
The versioned classification is `q128-growth-v1`; older immutable reporting facts retain their
original policy version. Classification for an open window is provisional; only the actual claim
closes it. Stable prefix cash is usable for budgeting, while final external/rounding facts are
recorded once per actual claim window. Do not sum provisional category assignments as final lifetime
losses.

Let `D = sum(f_i * Q - L_i * g_i)`. The implemented conservative residual bound is `ceil(D / Q)`,
plus one when non-owned growth exists. This includes quantization of the whole pool, even when our
position is tiny. Sum bounds across actual checkpoint windows; one global bound over all events is
insufficient after multiple claims. All arithmetic uses bounded protocol integers, without growing
rational denominators.

## Proof and capacity boundaries

The proof validates program owners, canonical migration address, original registry/config binding,
the position/NFT PDAs, exclusive fee-authority ownership and permanent position liquidity. A single
finalized account response supplies pool/position/custody state hashes. Same-slot transaction order
must include every relevant signature exactly once; missing/duplicate block membership fails closed.
`source: audit` is read-only and must never authorize a cash plan. Branded proof objects are deeply
frozen to prevent later mutation.

An immutable authenticated SQL checkpoint saves cumulative replay state after a complete transaction
that closes an actual position claim. The helper first reconciles replay with finalized pool and
position accounts. The checkpoint binds network, program, mint, canonical pool/position, migration
boundary, exact transaction/block index, account hashes and rolling history witness. Restoration
checks its HMAC, re-reads the actual finalized claim and canonical cursor, then replays every newer
successful transaction. Frozen event assignments remain in immutable prior checkpoint rows, so later
funding can select an older raw identity without rewriting its cash amount. A checkpoint whose
transaction trades again after the claim is not accepted as a closed-window boundary.

`FINANCIAL_CHECKPOINT_HMAC_KEY` is a dedicated, canonical base64 secret of at least 32 bytes.
`FINANCIAL_CHECKPOINT_KEY_ID` names the active key; retained old keys belong in the private
`FINANCIAL_CHECKPOINT_VERIFY_KEYS_JSON` map. Preserve verification keys during rotation; loss of a
key requires full verified archival replay. Database JSON ordering does not affect authentication.
Neither writable files nor an unauthenticated hash can replace a verified checkpoint.

Each replay pass is bounded to 10,000 successful transactions, 50,000 decoded events and 120
seconds. Checkpoints prevent these limits from applying to the lifetime of a routinely processed
pool. An oversized uncheckpointed suffix still needs a preserved archive and an explicitly reviewed
capacity/replay recovery; it issues no funding proof. Archive retention remains necessary for exact
cursor and claim-witness verification. Never skip history or invent a rounding allowance to make an
incomplete proof pass.

The stock SDK/current upstream fee structures expose base, dynamic and compounding controls;
protocol fee construction uses a fixed 20% cut. They do not expose a creator/partner switch
providing the intended LP-independent allocation. The relevant fields and conversion are in
[fee state](https://github.com/MeteoraAg/cp-amm/blob/main/programs/cp-amm/src/state/fee.rs) and
[fee parameters](https://github.com/MeteoraAg/cp-amm/blob/main/programs/cp-amm/src/params/fee_parameters.rs).
Do not treat raw fees belonging to outside LP positions as platform income.

## Release decision for fixed destinations

There is no inspected stock DAMM v2 SDK/mainnet pool-access setting that keeps public swaps enabled
while preventing outside position creation and liquidity additions. `can_add_liquidity`,
`can_create_position` and public `can_swap` share the pool enable flag in the primary
[access implementation](https://github.com/MeteoraAg/cp-amm/blob/main/programs/cp-amm/src/pool_action_access/permissionless.rs).
Its
[access module](https://github.com/MeteoraAg/cp-amm/blob/main/programs/cp-amm/src/pool_action_access/mod.rs)
exports the permissionless implementation; the early-activation whitelisted wallet is not an LP
allowlist. Disabling the pool also disables swaps. Permanent locking prevents withdrawal of our
original position; it does not prevent someone adding another position.

The owner approved the current-contract option on 28 October 2026: allocate actual income received
by the permanently owned position. The total trading-fee setting remains fixed, but the amount
received by each launch mode/platform is diluted when outside LP liquidity earns part of the LP
fees. This decision is no longer pending. See
[the owner decision record](MAINNET-OWNER-DECISIONS.md).

If fixed destinations must instead receive fixed shares of all pool trading fees, choose and audit a
settlement contract/DEX with enforceable non-LP fee recipients before LP division, or a separately
audited pool that can restrict LP additions while leaving swaps open. That requires a reviewed new
integration or protocol change; the inspected stock DAMM migration cannot supply it through a
configuration tweak. A frontend/router surcharge is bypassable through direct pool swaps, and
locking the original LP position is insufficient. The owner selected actual received income instead
of a new integration. The remaining mainnet gates concern production setup and acceptance; no
production deployment or historical balance is changed by this document.
