# MSKD devnet rehearsal and proposed holder payouts

No live rehearsal receipts are recorded yet. This document covers MSKD, Dev and Cashback. Legacy coins retain their original entitlements.

## Holder payout design for owner review

Use wallet-requested payouts. Once per UTC hour, take a full finalized SPL account snapshot at one bank, reconcile all balances to mint supply, then group accounts by owner. Record the actual slot and snapshot digest. Skip a missed boundary and carry the funded budget forward. Exclude verified DBC and DAMM vaults, LP custody, burn accounts and every configured company wallet. Record the exclusions with the snapshot.

Split actual collected non-protocol quote income 60% to the beneficiary and 40% to the house. Use integer cumulative accounting. For MSKD and Cashback, divide the beneficiary budget pro rata by eligible owner balance. Carry division dust into the next epoch. Keep each owner's earned balance across epochs until it reaches 0.001 units of the coin's quote currency. The house covers SOL network costs and required token account rent separately.

Persist each allocation once per network, coin, epoch and owner. Reserve the requesting owner's unpaid allocations in one database transaction. Bind the request to its owner, amount, asset and destination. Store the signed transfer before relay. Retry the same signature until finalized or proven expired. Verify the actual transfer, amount and destination against finalized chain data before marking the allocations paid. Publish the asset, epoch breakdown, snapshot slot, digest and finalized transfer signature.

Update 2026-11-23 (owner decision): MSKD pairs to SOL with the same 80 SOL bonding target as the other modes; hSOL is dropped (migration 026). Its holder budget is collected in SOL and converted to wXMR before payout (devnet: a mock 12-decimal mint in `MSKD_DEVNET_PAYOUT_MINT`). Quarantine any base-token fee receipts by mint until a separately reviewed conversion can produce a verified quote receipt. They do not create SOL or wXMR payout balances.

## Live acceptance record

For each mode, record both launches (with and without the optional first buy), mint, config, genesis, finalized creation signatures, launch-slot and next-slot fees, buy/sell signatures, migration, pre/post fee claims and beneficiary receipts. Verify the quote mint, actual fee splits and permanent LP lock. For holder modes, also record the snapshot, rollover, allocation and duplicate-request result.

## Controlled mainnet test

Complete and review all three devnet records first. Verify production RPC genesis, reviewed config digests, custody, account funding, operator recovery, restore and alert delivery. Keep public access closed. Prepare one coin per mode and present each transaction's exact network, public accounts, amount, fees and maximum cost to the owner before signing. Stop on any unmatched receipt, unexpected authority, network drift or unapproved spend.
