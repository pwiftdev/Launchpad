# Main wallet rotation — 31 October 2026

> Current status: [public launches are enabled](PUBLIC-OPENING-2026-11-01.md). The preparation and
> closed-gate states below are retained as the wallet rotation history.

The owner selected a new company collector for **new Bond it. launches**:

| Role                           | Public address                                 |
| ------------------------------ | ---------------------------------------------- |
| Main wallet / new collector    | `3j4vUdPKF7HNqKoaWdezQoX9Hognn6Us7ua6thZZiaed` |
| Treasury — unchanged           | `GfgpgQa2ZqNm17rJ6fw2t5nBApKKPZBn5M5niWW3riZZ` |
| Historical wallet-v1 collector | `5iskTyXpKn7HeqvNUFBFc1rv2C2EoFNBNyFmXgGFztgS` |

The current company recipients are recorded under `company` in
`docs/mainnet-authorities.public.json`. The original native-vault
governor/operator/upgrade-authority record remains unchanged; rotating a Meteora fee wallet does not
change a native program authority.

## Current and historical coins

New-launch admission, configuration preparation, registration, deployment examples and audits use
the new collector. A historical collector can be admitted only through an explicit legacy path; that
exception cannot authorize a new Bond it. config using the retired wallet.

Existing on-chain config fee rights and immutable database records remain associated with the old
collector. They are not rewritten. Historical reward balances/receipts remain readable from the
public app after its environment changes, but the new collector cannot reserve or spend those
old-wallet balances. The existing private worker remains attached to the historical collector and
continues unsigned indexing/planning with automatic execution disabled. New-policy signing needs the
new wallet's private signer to be installed separately; no private key was requested in chat.

## Replacement configuration

A fresh unsigned candidate was prepared with the new collector and unchanged treasury:

```text
2VN1TJVDbw8bxmMTJye8xzdTxVa93Uh8FUSt3UqGcqZ6
```

Its private config-account material is only in the ignored file
`.local/plzzz-bond-new-main-wallet-20261031.private.json`. The earlier candidate
`BRbJYYM5txAqhGXsfb3SeYhT2MriNLMjTRZ2j5Y5Qpee` is superseded and must not be used for the new
wallet. No config was deployed, and no transaction was signed or broadcast. Refresh the blockhash
before signing; the prepared transaction is not a permanent executable authorization.

At the finalized check on 31 October, the new collector had 0 SOL and the replacement config did not
exist on-chain. Funding and private signing access are still required before config creation and
funded acceptance. The public financial gate remains closed.

The live market config stays discoverable for existing coins until the new config is created,
verified and registered. Changing a public wallet setting cannot change the old on-chain account's
fee claimer. Future staged settings select the replacement candidate and retain the historical key
in `LEGACY_POOL_CONFIG_KEYS`.

The canonical site remains the existing Heroku URL, as requested. No domain/DNS change is part of
this rotation.

## Checks

Regression coverage verifies that the active wallet is required for new admission, an explicit
historical verification cannot redirect old config recipients, old balances remain readable, the new
wallet cannot reserve old funds, and the native authority record is unaffected. Wallet addresses
were checked for canonical encoding and an ordinary on-curve public key before preparation.

## Live deployment

Heroku source release v57 and wallet-setting release v58 succeeded. At the live verification on
31 October 2026 at 21:08 UTC, the web dyno was running with the new collector, unchanged treasury,
the existing Heroku origin, and financial execution disabled. The historical private worker kept
its original collector and automatic execution remained disabled.

All 608 application tests and 132 operational tests passed, along with TypeScript, the standalone
worker/startup smoke checks, and the live browser checks. Three historical creator reward views
were checked again after the rotation; balances and receipts were preserved. The replacement
Meteora config remains unsigned and undeployed, and no new signer has been installed.

### Local signer preparation follow-up

At 22:13 UTC on 31 October, the owner's locally saved private-key string was validated without
printing it. It derives the selected new collector address. A converted keypair, sign-only policy
and signer-command file were prepared under ignored `.local` paths, with Windows permissions
restricted to the owner's account. The standalone signer's configuration check passed without
loading a key or signing a transaction. The policy uses the existing operator's execution limits.

This is local preparation only: the new key has not been uploaded to Heroku, and no new financial
worker has been activated. The historical worker and public execution gates are unchanged. A fresh
finalized check still found 0 SOL in the new wallet and no replacement config on-chain. Funding,
config deployment/registration and installation of the new private runtime remain outstanding.

### Funded deployment follow-up

The owner subsequently funded the new wallet with 0.1 SOL. The replacement Meteora config was
created and finalized, registered, and wired into the deployed web and private operator. Its
creation cost 0.00598408 SOL, leaving 0.09401592 SOL. The new key is now installed only in the private
Heroku app. Historical accounting remains unsigned and historical coin records are preserved, while
old coins are hidden from the public launchpad as requested. The [clean deployment record](BOND-IT-CLEAN-DEPLOYMENT-2026-10-31.md) supersedes the earlier local-only state above and documents the
remaining funded acceptance checks before public financial execution is opened.
