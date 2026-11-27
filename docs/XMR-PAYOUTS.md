# Masked payouts: operator runbook

Masked collects trading fees in SOL. On My earnings, creators and holders can claim in wrapped
Monero (wXMR) or SOL, paid to their connected Solana wallet.

## wXMR payouts

The wallet operator wraps the claim's SOL, swaps it for wXMR and sends the guaranteed minimum to the
claiming wallet in one Solana transaction. The regular signer and wallet settlement process verify
the transaction before marking a payment final.

| Setting                             | Where                                     | Meaning                                                                                          |
| ----------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `MSKD_PAYOUT_POOL`                  | Web, operator and signer                  | Reviewed SOL/wXMR Meteora DLMM market. Use the same pool across all three.                       |
| `MSKD_DEVNET_PAYOUT_MINT`           | Web, operator and signer on test networks | A standard SPL mint with 12 decimals and no freeze authority. Mainnet uses the pinned wXMR mint. |
| `MASKED_WXMR_PAYOUTS_ENABLED`       | Web app                                   | Enables new wXMR claims when the matching market is configured.                                  |
| `MASKED_MINIMUM_XMR_CLAIM_LAMPORTS` | Web app                                   | Minimum in SOL earnings, default 0.05 SOL.                                                       |

For the private operator config, set `mskdPayout.pool` to the reviewed market. Set
`mskdPayout.devnetMint` to the stand-in mint on devnet or `null` on mainnet. On mainnet, use the
reviewed `dev-v1` deployment policy and set `maskedConfigKey` in the operator config. Set
`MAINNET_MASKED_CONFIG_KEY` to the same reviewed Masked config in the web and signer environments.
Set the signer payout limit to cover the maximum 1 SOL payment and leave collector SOL headroom for
fees and token-account rent.

- A payment spends at most 1 SOL of earnings; larger claims are paid in several payments, one at a
  time. The restricted signer also applies its payout limit to each one.
- The quote is valid for 20 seconds. A payment that cannot be quoted (thin liquidity, price impact
  above 1%) waits and is quoted again on the next pass.
- The claimant gets the minimum the swap guarantees, up to 1% under the quote. Whatever the swap
  returns above that stays in the company wXMR account.
- After 5 failed payments in a row, a claim with nothing paid yet returns its earnings to the wallet
  to claim again. A partly paid claim stops and is logged for review. Alerts are JSON lines with
  `"event":"masked_wxmr_alert"`.
- A wXMR claim uses one collector wallet. A worker picks up claims for its own collector and flags
  any existing claim that spans several collectors.

For a partly paid claim, review its finalized payments and the terminal failed jobs. Once the
failure is resolved, run
`node scaffolds/fun-launch/.worker/ops.cjs resume-wxmr --execute --id <latest-failed-payment-job-id>`
in the configured private operator environment. The next scheduler pass uses the existing receipts
to pay the remaining SOL entitlement in wXMR. Keep the original job ID if the command response is
lost. Repeating that ID cannot start another retry round.

## Native Monero upgrade

Direct payouts to Monero wallets are in development. The separate daily batch worker can process
already queued native claims and run isolated rehearsals.

### What runs where

| Part                 | Runs on                   | Notes                                                             |
| -------------------- | ------------------------- | ----------------------------------------------------------------- |
| Claim screen and API | Web app                   | Historical claims retain their encrypted address until settlement |
| `masked-payouts.cjs` | Operator machine          | Plans, signs, relays, confirms and settles batches                |
| `monero-wallet-rpc`  | Operator machine, private | Holds the treasury wallet; never exposed to the internet          |
| Monero node          | Remote node for now       | Later our own pruned node; only `--daemon-address` changes        |

## Start the wallet RPC

```bash
monero-wallet-rpc --wallet-file /secure/masked-treasury --password-file /secure/pw \
  --daemon-address <node-host>:18089 --trusted-daemon=false \
  --rpc-bind-ip 127.0.0.1 --rpc-bind-port 18083 --rpc-login masked:<long-random-password>
```

Use stagenet (`--stagenet` and a stagenet node) for every rehearsal.

## Operator settings

| Setting                                          | Meaning                                                         |
| ------------------------------------------------ | --------------------------------------------------------------- |
| `MONERO_WALLET_RPC_URL`                          | e.g. `http://127.0.0.1:18083`                                   |
| `MONERO_WALLET_RPC_LOGIN`                        | `user:password` given to `--rpc-login`                          |
| `MONERO_ADDRESS_KEY`                             | 32-byte lowercase hex; the same value as the web app            |
| `DATABASE_URL`, `RPC_URL`, `NEXT_PUBLIC_NETWORK` | As for the other operator processes                             |
| `MASKED_XMR_FEE_BPS`                             | Fee taken from the market rate, default 100 (1%)                |
| `MASKED_XMR_PAYOUT_HOUR_UTC`                     | Hour the daily batch is planned, default 12                     |
| `MASKED_FIXED_SOL_XMR_RATE`                      | Test networks only: fixed XMR per SOL instead of the price feed |
| `MASKED_TREASURY_RESTORE_HEIGHT`                 | Block the treasury wallet was created at; auditors scan from it |

Use an isolated database and seed test claims for stagenet rehearsals. The public claim API accepts
wXMR and SOL during the current rollout.

## Run

```bash
node scaffolds/fun-launch/.worker/masked-payouts.cjs loop
```

Every minute it writes a treasury heartbeat. From the payout hour, once a day, it:

1. Prices up to 15 waiting XMR claims at one rate from the price feed (CoinGecko), minus the fee.
2. Checks the treasury's unlocked balance covers them plus 0.02 XMR for network fees. If not, it
   logs `Treasury top-up needed: <piconero>` and pays nothing.
3. Signs the transaction and stores it, then relays it. A restart only resends the same signed
   transaction, never a new one.
4. After 10 confirmations, marks the claims paid, erases their addresses and credits the SOL behind
   them to each coin's platform share, which the treasury sweep withdraws.

If every transaction in a batch fails, the claims fail and their earnings return to the wallets. A
partly failed batch is logged for manual review and left untouched.

## Public proof

Hourly, and right after each batch settles, the process publishes the treasury's audit data for the
Proof page (`/proof`):

- The primary address and private view key, read from the wallet itself and checked to belong
  together before publishing. They show everything the treasury receives and cannot spend.
- Incoming transfers (the top-ups), shown on the Proof page as XMR received.
- Signed key images, stored when they change and downloadable from `/api/proof/key-images`. Imported
  into a view-only wallet, they show what the treasury spent.

A failure to publish is logged as a warning and never holds up payouts.

## Topping up the treasury

The treasury needs XMR before claims can be paid. Buy XMR with the SOL the sweep withdraws, through
any route, and send it to the treasury wallet's primary address. Funds count once they unlock (10
blocks). Alerts are JSON lines with `"event":"xmr_payout_alert"`.

## \$MSKD buyback and burn

Each Masked coin's 0.10% share moves in the ledger to the official \$MSKD coin's buyback budget
(`masked_mskd_buyback_transfers`), and the existing buyback job buys \$MSKD from its pool and burns
it. This only happens when \$MSKD uses the same collector wallet as the Masked coins. On test
networks set `MASKED_TEST_BUYBACK_MINT` to a registered stand-in coin.
