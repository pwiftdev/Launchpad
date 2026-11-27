# XMR payouts: operator runbook

Masked collects trading fees in SOL. Creators and holders claim their earnings on the My earnings
page in native XMR (wXMR while native payouts are down) or in SOL. SOL claims are ordinary payout
jobs. XMR claims wait for one daily batch that the operator process pays from the Monero treasury.

## What runs where

| Part                 | Runs on                   | Notes                                                        |
| -------------------- | ------------------------- | ------------------------------------------------------------ |
| Claim screen and API | Web app                   | Validates and encrypts the Monero address, reserves earnings |
| `masked-payouts.cjs` | Operator machine          | Plans, signs, relays, confirms and settles batches           |
| `monero-wallet-rpc`  | Operator machine, private | Holds the treasury wallet; never exposed to the internet     |
| Monero node          | Remote node for now       | Later our own pruned node; only `--daemon-address` changes   |

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

The web app also needs `MONERO_ADDRESS_KEY` and may set `MASKED_MINIMUM_XMR_CLAIM_LAMPORTS` (default
0.05 SOL) until the minimum is decided.

## Run

```bash
node scaffolds/fun-launch/.worker/masked-payouts.cjs loop
```

Every minute it writes a heartbeat (the claim screen offers wXMR when it is older than 15 minutes or
the wallet is unreachable). From the payout hour, once a day, it:

1. Prices up to 15 waiting XMR claims at one rate from the price feed (CoinGecko), minus the fee.
2. Checks the treasury's unlocked balance covers them plus 0.02 XMR for network fees. If not, it
   logs `Treasury top-up needed: <piconero>` and pays nothing.
3. Signs the transaction and stores it, then relays it. A restart only resends the same signed
   transaction, never a new one.
4. After 10 confirmations, marks the claims paid, erases their addresses and credits the SOL behind
   them to each coin's platform share, which the treasury sweep withdraws.

If every transaction in a batch fails, the claims fail and their earnings return to the wallets. A
partly failed batch is logged for manual review and left untouched.

## Topping up the treasury

The treasury needs XMR before claims can be paid. Buy XMR with the SOL the sweep withdraws, through
any route, and send it to the treasury wallet's primary address. Funds count once they unlock (10
blocks). Alerts are JSON lines with `"event":"xmr_payout_alert"`.

## When the Monero wallet is down

XMR claims keep queueing and are paid once the wallet is back. SOL claims are unaffected. While the
heartbeat is older than 15 minutes or the wallet is unreachable, the claim screen offers wXMR in
XMR's place, if `MASKED_WXMR_PAYOUTS_ENABLED=true` on the web app.

### wXMR payouts

The ordinary wallet operator pays wXMR claims; the Monero process is not involved. Each payment is
one company-wallet transaction that wraps the payment's SOL, swaps it for wXMR in the configured
market and sends exactly the quote's guaranteed minimum to the claiming wallet. Either all of it
happens or none of it does.

| Setting                       | Where           | Meaning                                                                                  |
| ----------------------------- | --------------- | ---------------------------------------------------------------------------------------- |
| `MSKD_PAYOUT_POOL`            | Wallet operator | The SOL/wXMR Meteora DLMM market the swap uses                                           |
| `MSKD_DEVNET_PAYOUT_MINT`     | Wallet operator | Test networks only: the wXMR stand-in mint                                               |
| `MASKED_WXMR_PAYOUTS_ENABLED` | Web app         | Offers wXMR on the claim screen; set it only once the operator has the market configured |

- A payment spends at most 1 SOL of earnings; larger claims are paid in several payments, one at a
  time. The restricted signer also applies its payout limit to each one.
- The quote is valid for 20 seconds. A payment that cannot be quoted (thin liquidity, price impact
  above 1%) waits and is quoted again on the next pass.
- The claimant gets the minimum the swap guarantees, up to 1% under the quote. Whatever the swap
  returns above that stays in the company wXMR account.
- After 5 failed payments in a row, a claim with nothing paid yet returns its earnings to the wallet
  to claim again. A partly paid claim stops and is logged for review. Alerts are JSON lines with
  `"event":"masked_wxmr_alert"`.
- Every claim item's coin must use the same collector wallet as the operator; otherwise the claim is
  left for review.

## \$MSKD buyback and burn

Each Masked coin's 0.10% share moves in the ledger to the official \$MSKD coin's buyback budget
(`masked_mskd_buyback_transfers`), and the existing buyback job buys \$MSKD from its pool and burns
it. This only happens when \$MSKD uses the same collector wallet as the Masked coins. On test
networks set `MASKED_TEST_BUYBACK_MINT` to a registered stand-in coin.
