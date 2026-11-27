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
