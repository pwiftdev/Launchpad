#!/usr/bin/env bash
# Run only inside the isolated rehearsal VM. All transaction endpoints are literal loopback.
set -euo pipefail
export PATH=/root/.cargo/bin:/opt/agave/solana-release/bin:$PATH
profile=${1:-devnet-binaries}
case "$profile" in
  devnet-binaries) lab=/root/rinsed-rehearsal; binary_prefix= ;;
  mainnet-binaries) lab=/root/rinsed-rehearsal-mainnet; binary_prefix=mainnet- ;;
  *) echo 'Unknown isolated validator profile'; exit 1 ;;
esac
artifacts=/root/rinsed-rehearsal/programs
node_bin=/root/rinsed-rehearsal/toolchain/node/bin/node
vault=/root/launchpad/programs/rinsed-vault/target/deploy
program_key="$vault/rinsed_vault-keypair.json"
mkdir -p "$lab/keys" "$lab/programs"
chmod 700 "$lab/keys"
for role in governor operator treasury creator community trader claimant; do
  if ! test -s "$lab/keys/$role.json"; then
    solana-keygen new --no-bip39-passphrase --silent --outfile "$lab/keys/$role.json" >/dev/null
  fi
done
if [ "$profile" = mainnet-binaries ]; then
  program_key="$lab/keys/vault-program.json"
  if ! test -s "$program_key"; then solana-keygen new --no-bip39-passphrase --silent --outfile "$program_key" >/dev/null; fi
fi
profile_running=false
if test -s "$lab/validator.pid"; then
  fixture_pid=$(cat "$lab/validator.pid")
  if kill -0 "$fixture_pid" 2>/dev/null && [ "$(ps -o stat= -p "$fixture_pid" | cut -c1)" != Z ]; then
    fixture_args=$(tr '\0' ' ' < "/proc/$fixture_pid/cmdline")
    case "$fixture_args" in *solana-test-validator*--ledger\ "$lab/ledger"*) profile_running=true;; *) echo 'Fixture PID identifies another process'; exit 1;; esac
  fi
fi
if [ "$profile_running" = false ]; then
  if curl --silent --max-time 1 --output /dev/null http://127.0.0.1:8899; then
    echo 'Another local RPC is active; stop its exact fixture process before selecting a new profile' >&2; exit 1
  fi
  nohup solana-test-validator --bind-address 127.0.0.1 --rpc-port 8899 --faucet-port 9900 \
    --ledger "$lab/ledger" --limit-ledger-size 10000000 \
    --bpf-program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN "$artifacts/${binary_prefix}dbc.so" \
    --bpf-program cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG "$artifacts/${binary_prefix}damm.so" \
    --bpf-program metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s "$artifacts/${binary_prefix}metadata.so" \
    --account A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck "$artifacts/${binary_prefix}migration-config.json" \
    --quiet >"$lab/validator.log" 2>&1 </dev/null &
  echo $! > "$lab/validator.pid"
fi
for attempt in $(seq 1 30); do
  if curl -fsS -X POST -H 'Content-Type:application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getGenesisHash"}' http://127.0.0.1:8899 > "$lab/genesis.pending.json"; then
    if test -s "$lab/genesis.json"; then
      cmp "$lab/genesis.json" "$lab/genesis.pending.json" || { echo 'Local genesis changed; explicit new rehearsal approval required'; exit 1; }
    else
      mv "$lab/genesis.pending.json" "$lab/genesis.json"
    fi
    break
  fi
  sleep 1
done
test -s "$lab/genesis.json"
"$node_bin" - "$lab/genesis.json" <<'NODE'
const fs = require('node:fs');
const genesis = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).result;
if (!/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(genesis) ||
    ['5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d','EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG','4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY'].includes(genesis))
  throw new Error('Airdrop/deployment is restricted to the isolated validator genesis');
NODE
for role in governor operator treasury creator community trader claimant; do
  address=$(solana-keygen pubkey "$lab/keys/$role.json")
  solana airdrop 1000 "$address" --url http://127.0.0.1:8899 --commitment confirmed >/dev/null
done
# DBC's public global authority lends pool-creation rent, then the migration payer reimburses it.
# This protocol bootstrap is separate from fees and never enters a vault budget.
dbc_rent_buffer=FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM
buffer_lamports=$(solana balance "$dbc_rent_buffer" --lamports --url http://127.0.0.1:8899 | awk '{print $1}')
if [ "$buffer_lamports" -lt 1000000000 ]; then
  solana transfer "$dbc_rent_buffer" 1 --allow-unfunded-recipient --keypair "$lab/keys/operator.json" \
    --url http://127.0.0.1:8899 --commitment confirmed >/dev/null
fi
test -s "$vault/rinsed_vault.so"
test -s "$program_key"
solana program deploy "$vault/rinsed_vault.so" --program-id "$program_key" \
  --upgrade-authority "$lab/keys/governor.json" --keypair "$lab/keys/governor.json" \
  --url http://127.0.0.1:8899 --commitment confirmed --output json
"$node_bin" - "$lab" "$program_key" "$profile" <<'NODE'
const fs = require('node:fs');
const root = process.argv[2], programKey = process.argv[3], profile = process.argv[4];
const { Keypair } = require('/root/rinsed-rehearsal/node_modules/@solana/web3.js');
const pub = (file) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, 'utf8')))).publicKey.toBase58();
const roles = Object.fromEntries(['governor','operator','treasury','creator','community','trader','claimant'].map(role => [role,pub(`${root}/keys/${role}.json`)]));
const fixture = { profile, rpcUrl:'http://127.0.0.1:8899', networkGenesis:JSON.parse(fs.readFileSync(root+'/genesis.json','utf8')).result, programId:pub(programKey), roles };
fs.writeFileSync(root+'/fixture.json',JSON.stringify(fixture,null,2)+'\n');
console.log(JSON.stringify(fixture));
NODE
