> Historical reference: new plzzz.bond launches follow
> [the current Bond it. deployment guide](LIVE-DEPLOYMENT.md). Earlier fee schedules, mode choices
> and native-vault instructions below do not configure new bond-v1 launches.

# Coin economics: observed behavior and missing features

Snapshot: **26 October 2026, 21:18 UTC**, Solana devnet, confirmed slot `515464361`. Read-only
investigation of the deployed Heroku settings, live config, all four pool/mint/vault accounts and
their available transaction histories. No fees were claimed, no settings changed, and no transaction
was signed or sent.

**Main finding:** bonding-curve trading fees currently accrue 20% to Meteora and 80% to the partner.
The live creator trading-fee allocation is zero. The advertised creator/holder/burn router is not
implemented. The same wallet currently fills both creator and partner roles, which can hide this
difference in testing.

## Addresses and launch ownership

| Role                              | Observed address or behavior                   |
| --------------------------------- | ---------------------------------------------- |
| Live DBC config                   | `53k7otaALZ9QwhciXv9Wm8SVP5tek3iVUrNjZ4DQB6Pj` |
| Meteora DBC program               | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`  |
| Partner fee claimer               | `5iskTyXpKn7HeqvNUFBFc1rv2C2EoFNBNyFmXgGFztgS` |
| Leftover token receiver           | Same `5isk…ztgS` address                       |
| Creator of all four current pools | Same `5isk…ztgS` address                       |
| Program authority for pool vaults | `FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM` |
| Testcoin mint                     | `CzTxg2nRDQuyPmfyQ3AhP3fha1DXYedURLy8C8vV134e` |
| Testcoin pool                     | `4YdGdhax1qVTQTCRL5UCsnj5F9M9hXxpw2MBSDjZQMLa` |
| Testcoin token vault              | `4um4itgrgb72JNG1dNfThUeXEXy2RJPG855fEBMze2EW` |
| Testcoin SOL/WSOL vault           | `2xR8cEoP9bwGkVJk4z4HYeqk5dHxJs3gFXnZFgEhsiHr` |

The connected wallet pays and signs a launch and becomes its pool creator. A fresh mint keypair is
generated in the browser and adds its setup signature before the connected wallet signs. The web
server builds an unsigned transaction and relays the signed result. This launch flow does not use a
server-held deployment wallet. Another user launching through the app would be the creator of that
pool; the config's partner fee claimer would still be `5isk…ztgS`.

The partner address is a normal System Program-owned, on-curve account with zero data bytes. The
current config names one address as claim authority; no separate payout router or on-chain multisig
is wired into that role. The chain does not identify the human controlling a private key. Pool
vaults are program-controlled accounts, not that wallet's personal balances.

## Actual coins

The current config has four on-chain pools: TESTCOIN, RINSE, P2SCH and P2FB. None has graduated. All
four mints have 1,000,000,000 tokens, six decimals, no mint authority and no freeze authority. They
are standard SPL tokens, not Token-2022 transfer-tax tokens. All four metadata accounts are
immutable with the update authority set to the default address. The three older test deployments use
placeholder `example.com` metadata URIs; Testcoin has real pinned metadata and artwork.

The 25 illustrated sample launches in the board are fictional fixtures, not another 25 on-chain
tokens. Their displayed activity is sample data.

## Bonding-curve trading fees

Fees are paid in SOL/WSOL on both buys and sells. A buy pays from the SOL input; a sell pays from
the SOL output. The configured exponential base-fee schedule is:

| Time after activation | Base fee, approximately |
| --------------------- | ----------------------: |
| 0–3 seconds           |                     90% |
| 3–6                   |                 55.962% |
| 6–9                   |                34.7972% |
| 9–12                  |                21.6369% |
| 12–15                 |                13.4538% |
| 15–18                 |                 8.3656% |
| 18–21                 |                 5.2017% |
| 21–24                 |                 3.2344% |
| 24–27                 |                 2.0112% |
| 27 seconds onward     |              1.2505439% |

Dynamic fees are enabled. The configured maximum addition is approximately 0.2498645 percentage
points, making the post-window total approximately 1.2505%–1.5004% before amount-rounding effects.
The app's statement that the fee stays at exactly 1.25% is therefore incomplete.

The bundled creator first buy is eligible for the minimum-fee path rather than the starting 90% fee.
The app limits its selected target to 2% of supply and sets no referral account. That target limit
is in the app/API, not a wallet ownership or later-purchase restriction in DBC.

The live config has `creatorTradingFeePercentage = 0`:

| Recipient                      | Actual share of total trading fee | Nominal share of a trade at a 1.25% total fee |
| ------------------------------ | --------------------------------: | --------------------------------------------: |
| Meteora                        |                               20% |                                         0.25% |
| Partner                        |                               80% |                                         1.00% |
| Token creator's creator bucket |                                0% |                                            0% |
| Token holders                  |         No implemented allocation |                  0% automatically distributed |

Our transactions include no referral. An external integration can include one; it receives 20% of
the protocol portion, or 4% of the whole trading fee, leaving 16% for Meteora. It does not add a
second fee or reduce the partner's 80% share.

These fees accumulate in the quote vault with separate on-chain entitlement counters. Authorized
claims move them out. The app does not automatically forward them to a wallet after every trade. The
generic Studio CLI can build claims, but the web app has no complete fee-claim/distribution flow.

At the snapshot:

| Coin     | Partner trading fee, SOL | Meteora trading fee, SOL | Creator trading fee, SOL |
| -------- | -----------------------: | -----------------------: | -----------------------: |
| TESTCOIN |              0.007927829 |              0.001981956 |                        0 |
| RINSE    |              0.000100044 |              0.000025011 |                        0 |
| P2SCH    |              0.007300044 |              0.001825011 |                        0 |
| P2FB     |              0.005477446 |              0.001369360 |                        0 |
| Total    |              0.020805363 |              0.005201338 |                        0 |

## Launch costs

Each pool charges a 0.02 SOL creation fee, allocated 90% to the partner (0.018 SOL) and 10% to
Meteora (0.002 SOL). It is separate from trading fees, account funding and transaction fees. All
four creation fees remain unclaimed: each pool's native SOL balance is exactly 0.02 SOL above its
rent-exempt minimum, and its creation fee claim bits are zero. Thus another 0.072 SOL is allocated
to the partner and 0.008 SOL to Meteora across those four launches.

Total unclaimed partner-side creation plus trading fees: **0.092805363 SOL**. This is a devnet
contract entitlement, not an assertion that this amount reached a personal wallet.

Testcoin's actual launch transaction debited its creator wallet by:

| Item                                   |         SOL |
| -------------------------------------- | ----------: |
| Creator buy, including its trading fee | 0.526469372 |
| Pool creation fee                      | 0.020000000 |
| Funding newly created accounts         | 0.022070080 |
| Solana transaction fee                 | 0.000010000 |
| Total wallet debit                     | 0.568549452 |

The creator buy received 20,000,000.017504 tokens, approximately 2% of supply. Its included trading
fee was 0.006583731 SOL: partner 0.005266985, Meteora 0.001316746, creator bucket zero. Do not add
that trading fee again to the table total.

The later 10,000,000-token sale returned 0.259059900 SOL before the separate 0.000758000 SOL
transaction fee, increasing the wallet's SOL balance by 0.258301900. Approximately 10 million tokens
remain with that wallet. This sell happened before graduation; no creator-sale penalty router ran.
Network fees can include a priority fee and are not platform revenue. New-account funding is also
not the same as platform revenue or a guaranteed refund.

Launch transaction:
[58qNt6h9…](https://solscan.io/tx/58qNt6h9KQqkx7Esh64s6H3fBrtqy3rByDxpH6injwi5WLXBZ4Qf3qGGJ3JfxapxLtEBY2nRk8L2MdCPTPMRo6Cf?cluster=devnet).

## Graduation settings

The curve becomes eligible for DAMM v2 migration at 80 SOL of quote reserve. This means curve
reserves after relevant trading accounting, not market cap or gross trading volume.

- A configured 2% migration charge removes 1.6 SOL at exactly the 80 SOL threshold: 0.8 SOL for the
  creator and 0.8 SOL for the partner.
- A separate 0.2% protocol liquidity migration fee reduces migration liquidity.
- Final-swap quote surplus above the threshold is separate: 20% protocol, 80% partner under the
  current zero creator trading-fee share. Leftover base tokens after migration go to the configured
  leftover receiver, not automatically to holders or a burn address.
- Migrated LP allocation is 50% partner permanently locked and 50% creator permanently locked, with
  no unlocked allocation. Locked liquidity can still earn claimable fees.
- The selected fixed DAMM config is `Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp`. Its actual
  devnet account has a 1% base trading fee, dynamic fees enabled (up to approximately 0.1999
  percentage points), 20% protocol share and quote-side fee collection. At a nominal 1% total fee,
  the planned 50/50 LP ownership implies 0.2% of trade value for protocol and 0.4% for each LP
  owner.

Those are configuration facts; none of the four coins has completed a graduation rehearsal. The web
app has no migration worker, and Meteora's documented automatic keeper runs on mainnet. Devnet
requires a manual or separately operated migration trigger. The app also needs a complete trading
handoff after graduation; its DBC swap APIs reject migrated coins.

## Promises that need implementation or correction

| Current product claim                                      | What exists today                                                                                                                        |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 0.75% creator / 0.25% platform / 0.25% Meteora             | Live pre-migration creator share is zero; partner receives all non-protocol fees.                                                        |
| Holders receive 80% of excess launch tax                   | `computePot()` calculates a proposed amount; no dedicated funded escrow, distribution or holder claim flow.                              |
| Payout at bond or settlement after 72 hours                | UI rules and countdown; no implementing settlement worker/program found. The countdown does not itself expire the pool or refund anyone. |
| Earn / Split / Community buyback-and-burn modes            | Burn choice saved in metadata JSON; no implemented fee router or automatic buyback/burn execution.                                       |
| Creator sells or exceeds a 2% cluster cap: fees redirected | No enforcing router or cluster ownership system. First-buy target restriction does not enforce total ownership.                          |
| Fixed 1.25% after the launch window                        | Base rounds to about 1.25054%, and live dynamic fees can add more.                                                                       |
| Automatic complete graduation                              | Configuration and SDK/Studio capabilities exist; no complete app worker and post-migration trade flow.                                   |

For direct creator sharing at the nominal 1.25% fee, a 75% creator share of the 80% non-protocol
allocation would produce the advertised 0.75% creator / 0.25% partner / 0.25% protocol example. That
change alone would not implement holder pots, burn modes or penalties. Those promises need an actual
accounting and payment design. Editing frontend constants or the local JSON does not retroactively
change the on-chain settings of already-created pools.

## Evidence

- Deployed settings were read through the authenticated Heroku API; only public addresses and
  selected public settings were recorded. Secret values were not printed or copied into this report.
- Direct Solana RPC reads verified config, pool balances, token mint authorities, metadata flags,
  transaction signers, fee payer, balance changes and decoded DBC events.
- `src/pages/launch.tsx`: fresh browser mint keypair and wallet signing.
- `src/pages/api/upload.ts`: payer/creator assignment, no-referral first buy and metadata-only burn
  choice.
- `src/constants/launch.ts`, `src/pages/rules.tsx`, `src/lib/pot.ts`: intended product economics and
  calculations.
- [Meteora fee accounting](https://docs.meteora.ag/core-products/dbc/fees/overview),
  [claim roles](https://docs.meteora.ag/core-products/dbc/accounts-and-permissions),
  [fee formulas](https://docs.meteora.ag/core-products/dbc/formulas),
  [migration](https://docs.meteora.ag/core-products/dbc/migration-and-liquidity),
  [surplus/leftover](https://docs.meteora.ag/core-products/dbc/surplus-and-leftover),
  [Solana transaction fees](https://solana.com/docs/core/fees).
