# Masked: brief for legal counsel

We want advice before the public relaunch. This brief describes how Masked works today and lists the
questions we need answered. It states facts about the product, not legal conclusions.

## What Masked is

A launchpad on Solana where anyone can create a memecoin. Trading happens in pools run by a third
party (Meteora). Each trade pays a 1.25% fee, split by fixed rules:

| Share                  | Rate  | Who receives it                                              |
| ---------------------- | ----- | ------------------------------------------------------------ |
| Pool protocol          | 0.25% | Meteora                                                      |
| Creator and holders    | 0.60% | Split by a ratio the creator picks at launch, locked forever |
| Company                | 0.30% | Masked                                                       |
| $MSKD buyback and burn | 0.10% | Used to buy Masked's own token and destroy it                |

The holders' part is divided among everyone holding the coin, weighted by how much they held and for
how long during each hour.

## How money moves

1. A company-controlled wallet collects the fees in SOL and holds them until claimed.
2. Creators and holders sign a claim on our site for everything they earned across all coins.
3. They choose to be paid in:
   - **wXMR**, a Monero-pegged token on Solana issued by a third party. The company swaps the
     claim's SOL for wXMR and sends it to the signing wallet in one transaction.
   - **SOL**, sent to the wallet that signed.
4. Trades and these payout transfers are public on Solana. The launch flow collects no names, email
   addresses or identity documents. The site currently serves all countries.
5. A public proof page shows daily totals of fees collected, SOL and wXMR payouts, and burns. Anyone
   can look up a Solana wallet's unpaid earnings and claim history without connecting a wallet.

Direct payouts to Monero wallets are in development. The planned flow converts SOL earnings at a
daily rate, with a 1% fee, and pays from Masked's XMR treasury. The questions about native XMR and
its treasury apply to that upgrade.

## Questions

### Securities

1. Could a coin launched on Masked, or $MSKD, be a security because holders receive a share of
   trading fees? Does it matter that the creator, not Masked, chooses the holders' share, and that
   it is locked at launch?
2. Does the $MSKD buyback and burn change that analysis?

### Money transmission and custody

3. Does holding earned fees in a company wallet until claimed, and then paying them out, make Masked
   a money transmitter or custodian? In which jurisdictions?
4. Does converting a user's SOL earnings into XMR (or wXMR) and sending it to an address they give
   us count as exchange or transmission?
5. Does the 1% conversion fee change anything?

### Privacy coins, AML and sanctions

6. What obligations come with paying out in Monero, given that many exchanges and some jurisdictions
   restrict privacy coins?
7. Do we need sanctions screening (for example OFAC) of Solana wallets that claim? Monero
   destinations cannot be screened the same way: what is expected of us?
8. Are there claim sizes or volumes above which identity checks become required?

### Tax and reporting

9. Are creator and holder payouts income we must report, and to whom?
10. How should the company account for its 0.30% share, the XMR treasury, and the burned $MSKD?

### Product and marketing

11. Is the line "your trades are public, what you earn isn't" acceptable, or does it invite
    regulatory risk?
12. Should we restrict any countries now, given we currently block none?
13. What do our terms of service and privacy policy need to say, including about the deleted Monero
    addresses and the public proof page?
14. Which entity should operate this, and where?

## What we need back

A short written view on each question, which jurisdictions matter most, anything we must change
before relaunch, and anything that can wait.
