> Historical reference: new plzzz.bond launches follow
> [the current Bond it. deployment guide](LIVE-DEPLOYMENT.md). Earlier fee schedules, mode choices
> and native-vault instructions below do not configure new bond-v1 launches.

# Mainnet owner decisions — 28 October 2026

These decisions were explicitly supplied by the project owner after reviewing the remaining launch
requirements. They update the release plan; they do not attest a mainnet deployment or authorize
invented production addresses.

## Approved decisions

- **Fee basis:** allocate actual fee income received by the permanently owned liquidity position.
  Outside liquidity earns its own fees and can reduce our received income. Fixed destination shares
  of every pool trade are no longer a product requirement. The existing funded settlement math
  already enforces actual receipts; no balance or historical allocation is rewritten.
- **Trading schedule:** keep the 90% starting RINSE schedule and the accepted rounded endpoint.
  Public marketing remains 1.25%; quotes retain actual execution math. Buyback/burn and both launch
  modes remain in place. No internal destination percentages are introduced into public copy.
- **Outside security audit:** the owner explicitly declined it. Internal reviews and tests remain
  evidence, but no independent audit is claimed. This is recorded as `owner-declined`, never as a
  successful audit. It is no longer an owner-required prerequisite.
- **Authority ownership:** the project owner controls all roles and supplied their intended public
  addresses in [the authority record](mainnet-authorities.public.json): treasury
  `GfgpgQa2ZqNm17rJ6fw2t5nBApKKPZBn5M5niWW3riZZ`; governor, operator and program upgrade authority
  `5iskTyXpKn7HeqvNUFBFc1rv2C2EoFNBNyFmXgGFztgS`. The owner explicitly chose one shared address for
  the latter three roles. An operator signer for that address also controls governance/upgrades;
  preserve this assignment and restrict its signing access accordingly. Governor, operator and
  treasury are fixed at native initialization; verify signing access and the actual on-chain binding
  before initialization.
- **Operational ownership:** the project owner is responsible for alerts, pausing and restore
  response. Operator-host location, signing integration and actual monitoring delivery remain to be
  configured and tested.
- **RPC:** the owner supplied a Helius mainnet endpoint. Its credential is stored only in ignored
  private preparation settings; it is absent from this document and public browser configuration.

## RPC evidence

Read-only live probes verified mainnet genesis, healthy service, finalized blocks/blockhashes,
full-context SPL token-account queries, recent DBC signature history and transaction retrieval. The
closing genesis check matched. No wallet was loaded, no transaction was signed or broadcast, and no
Heroku setting or production database was changed. The redacted report is
`.local/owner-mainnet-rpc-check.json`.

An initial probe used an unsupported parameter arrangement and was corrected; its failure report is
preserved separately. These probes do not prove a provider plan's contractual retention,
long-running capacity or future history availability.

Both owner-supplied addresses passed canonical-address and on-curve checks. A finalized mainnet
account read found neither account present and a zero SOL balance for each. A fresh unfunded wallet
address can still be valid; this does not prove control of its signing key. The read-only report is
`.local/mainnet-authority-check.json`. No key was loaded or generated and no transaction was signed
or sent. The intended roles are copied into `.local/mainnet-preflight-draft.public.json`; program,
config, code and other unverified pins remain explicit placeholders. Private preparation settings
are separate from the active web environment.

## Remaining concrete setup

1. Establish and verify custody/signing for the supplied production addresses. Their intended roles
   are now recorded; a valid address and public balance are not proof of signing access. Calculate
   deployment/account/transaction costs before funding; both supplied wallets were unfunded at the
   recorded check.
2. Select the private always-on operator host and integrate its approved signer. The local VM signer
   is not a production signer. Keep signing keys outside the public web application.
3. Prepare and verify deployment costs, funding, program deployment, native initialization and
   config approval against independently pinned production addresses and code. Do not reuse fixture
   keys.
4. Configure and verify production restore, alert delivery, operator restart/recovery and actual
   iOS/Android wallet flows.
5. Build and verify the final release after production configuration and signer integration. The
   previously tested `cf8ca8cb...` artifact predates this decision/report/copy update and remains
   preserved as earlier evidence. No new build or deployment is implied by these decisions.

The current mainnet gates remain closed because production setup and acceptance are incomplete.
Owner decisions do not bypass native recipient checks, funded balances, complete history, signature
verification or immutable registration. No further outside-audit permission is requested.
