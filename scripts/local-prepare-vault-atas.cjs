/* Rent-only local setup. Fee collection and budget allocation remain journal-controlled. */
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const workspace = path.resolve(__dirname, '..');
const appRequire = Module.createRequire(path.join(workspace, 'scaffolds/fun-launch/package.json'));
const { PublicKey, Transaction } = appRequire('@solana/web3.js');
const { TOKEN_PROGRAM_ID, NATIVE_MINT, createAssociatedTokenAccountIdempotentInstruction, getAccount } = appRequire('@solana/spl-token');
const { createLocalSender } = require('./local-vm-sender.cjs');

function loadAddresses() {
  const filename = path.join(workspace, 'scaffolds/fun-launch/src/lib/vault/client.ts');
  const ts = appRequire('typescript');
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: filename });
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(output.outputText, filename);
  return loaded.exports.vaultAddresses;
}

async function main() {
  const requestedMint = process.argv[2];
  if (process.argv.length > 3) throw new Error('Pass at most one local fixture mint');
  const sender = await createLocalSender();
  const statePath = path.join(workspace, '.local/meteora-rehearsal-state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  if (state.networkGenesis !== sender.fixture.networkGenesis || state.programId !== sender.programId.toBase58()) throw new Error('Fixture identity mismatch');
  const coins = state.coins.filter(coin => !requestedMint || coin.mint === requestedMint);
  if (!coins.length) throw new Error('No matching local fixture coin');
  const addresses = loadAddresses();
  for (const coin of coins) {
    const mint = new PublicKey(coin.mint), a = addresses(sender.programId, mint);
    if (await sender.connection.getAccountInfo(a.quoteAccount, 'confirmed')) {
      const quote = await getAccount(sender.connection, a.quoteAccount, 'confirmed');
      if (!quote.owner.equals(a.coin) || !quote.mint.equals(NATIVE_MINT) || quote.amount !== 0n) throw new Error('Existing quote ATA is not empty canonical custody WSOL');
    }
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(sender.roles.operator, a.tokenAccount, a.coin, mint, TOKEN_PROGRAM_ID),
      createAssociatedTokenAccountIdempotentInstruction(sender.roles.operator, a.quoteAccount, a.coin, NATIVE_MINT, TOKEN_PROGRAM_ID)
    );
    const result = await sender.send(tx, { roles: ['operator'] });
    state.vaultSetupTransactions ??= [];
    state.vaultSetupTransactions.push({ mint: coin.mint, label: 'canonical-vault-ata-rent-only', ...result });
    fs.writeFileSync(statePath + '.tmp', JSON.stringify(state, null, 2) + '\n');
    fs.renameSync(statePath + '.tmp', statePath);
    const started = Date.now();
    while ((await sender.connection.getSignatureStatuses([result.signature])).value[0]?.confirmationStatus !== 'finalized') {
      if (Date.now() - started > 45000) throw new Error('Rent setup not finalized yet');
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    console.log(JSON.stringify({ mint: coin.mint, quoteAccount: a.quoteAccount.toBase58(), tokenAccount: a.tokenAccount.toBase58(), ...result, finalized: true }));
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
