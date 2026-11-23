# Clean Bond it. deployment — 31 October 2026

> Update: [public mainnet launches were enabled on 1 November](PUBLIC-OPENING-2026-11-01.md) at the
> owner's request. The closed-gate state in this deployment record describes the preceding stage.

The public launchpad now shows only coins belonging to registered `bond-v1` configurations.
Historical configuration keys are ignored by public discovery, even when they remain in the
environment or immutable registry. This applies to the board, trending, market discovery, direct
coin lookups and shared token pages. Old token pages return HTTP 404. The production board is empty
because no new Bond it. coins have been launched yet; sample coins are disabled.

Historical configuration and coin records were compared before and after deployment. Their counts
and checksums are unchanged. Nothing was deleted from the database or the blockchain.

## New wallet and finalized configuration

| Item                                    | Value                                                              |
| --------------------------------------- | ------------------------------------------------------------------ |
| Main collector                          | `3j4vUdPKF7HNqKoaWdezQoX9Hognn6Us7ua6thZZiaed`                     |
| Treasury, unchanged                     | `GfgpgQa2ZqNm17rJ6fw2t5nBApKKPZBn5M5niWW3riZZ`                     |
| Deployed Meteora config                 | `2VN1TJVDbw8bxmMTJye8xzdTxVa93Uh8FUSt3UqGcqZ6`                     |
| Finalized account SHA256                | `2fe8bacae26806bb3bf3aba4cb51332593181da9ba927f6c60b16b2856835f21` |
| Creation cost                           | 0.00598408 SOL                                                     |
| Remaining wallet balance after creation | 0.09401592 SOL                                                     |

Creation transaction:
`2kHE2pqGuDRMCNaCX8FSUoW4qcSbmvVSbqUX8nrkiR9JgJDDieprNefMvx164cACfRfbJyg4waJVgJM9UwzhVndG`.

The transaction was simulated with valid signatures before broadcast. Its resulting account was
decoded and checked against the Bond it. policy, collector and treasury. Finalized on-chain bytes
matched the digest established by that simulation. Creation was capped at 0.01 SOL and used the
existing candidate account, rather than creating another config. The verified config is registered
and enabled in the database.

## Heroku runtime

The web is running release v62 at
`https://rinsed-launchpad-1675f6b9bebf.herokuapp.com`. Both runtime and public build use the new config.
The custom domain remains a later owner task.

The new wallet's key was validated from the owner's private local file, converted to a keypair and
installed only in `rinsed-launchpad-operator`. A read-only diagnostic on that private Heroku app
verified the installed key against the packaged collector without signing or broadcasting. No key
was placed in the public web app or any source archive. Signing secrets were removed during the
private build and restored afterward.

The private worker alternates two profiles on its existing single Basic dyno:

- Bond it.: the new collector, new config and restricted automatic signer.
- Historical: the original collector and config, with unsigned indexing/planning only. No signer
  command is supplied to these cycles. The historical key is retained privately for rollback and
  removed from the bootstrap environment before child processes start.

Both profiles have fresh successful database heartbeats and zero failed jobs. At verification, no
operator transactions had been signed or sent; the new profile has zero registered coins to process.
The reviewed bootstrap is in `deploy/private-worker/bootstrap.cjs`.

**Public launch/trading execution remains disabled** (`MAINNET_TRADING_ENABLED=false` on the web).
The new config and private signer are installed, but a funded new-token lifecycle—including actual
trades, graduation, buyback/burn and creator payout—has not been completed on this config. An empty
healthy worker is not evidence of those transactions succeeding.

## Verification

All 611 application tests and 135 operational tests passed. TypeScript, lint on changed app files,
standalone worker portability checks and the deployed Linux builds passed. Regression checks cover
policy-filtered discovery, preservation of historical records, strict collector pins, key identity
validation and the absence of automatic signing on historical cycles.

Read-only live checks confirmed zero old coins on the board and trending lists, HTTP 404 for the
three registered historical coins' API/detail pages, unchanged historical records, matching new
runtime pins and healthy private profiles. Real desktop and 390px mobile browser checks passed for
the empty board, launch form, rules and branded share card, with no page errors or failed APIs.
