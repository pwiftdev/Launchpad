// Builds the public proof page's view, shared by every visitor for 30 seconds.
import { PublicKey } from '@solana/web3.js';
import { connection } from './dbc';
import { configuredCompanyWallets, NETWORK_GENESIS } from './launchConfig';
import { sharedRead } from './display';
import { ProofStore, PROOF_DAYS } from './proofStore';
import { WalletStore } from './economics/walletStore';
import { mskdBuybackMint } from './economics/maskedBuyback';
import type { MoneroNetwork } from '@/lib/monero';
import type { BurnReceipt, ProofView } from '@/lib/proof';

const store = new ProofStore();
export const proofMoneroNetwork = (genesis: string): MoneroNetwork =>
  genesis === NETWORK_GENESIS['mainnet-beta'] ? 'mainnet' : 'stagenet';

function companyWallets(genesis: string) {
  try {
    const { collector, treasury } = configuredCompanyWallets(genesis);
    return { collector: collector.toBase58(), treasury: treasury.toBase58() };
  } catch {
    return null;
  }
}

async function collectorBalance(address: string): Promise<string | null> {
  try {
    return String(await connection.getBalance(new PublicKey(address), 'finalized'));
  } catch {
    return null;
  }
}

async function build(genesis: string): Promise<ProofView> {
  const mskd = mskdBuybackMint(genesis);
  const wallets = companyWallets(genesis);
  const since = new Date(
    Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate())
  );
  since.setUTCDate(since.getUTCDate() - (PROOF_DAYS - 1));
  const [days, receipts, xmr, treasury] = await Promise.all([
    store.days(genesis, mskd, since),
    store.receipts(genesis, mskd),
    store.xmrReserves(genesis),
    store.treasury(genesis, proofMoneroNetwork(genesis)),
  ]);
  let reserves: ProofView['reserves'] = null;
  if (wallets) {
    const [custody, balance] = await Promise.all([
      new WalletStore().custodyRequirement(genesis, wallets.collector),
      collectorBalance(wallets.collector),
    ]);
    reserves = {
      collector: wallets.collector,
      heldLamports: custody.liability.toString(),
      balanceLamports: balance,
      ...xmr,
    };
  }
  return {
    networkGenesis: genesis,
    generatedAt: new Date().toISOString(),
    days,
    recentCollections: receipts.collections,
    recentBurns: receipts.burns,
    reserves,
    treasury,
    controls: await store.controls(genesis, wallets, mskd, treasury?.address ?? null),
  };
}

export const proofView = (genesis: string) =>
  sharedRead(`proof:${genesis}`, () => build(genesis), 30_000);
async function tokenSupply(mint: string) {
  try {
    const supply = await connection.getTokenSupply(new PublicKey(mint), 'finalized');
    return { amount: supply.value.amount, decimals: supply.value.decimals };
  } catch {
    return null;
  }
}

/** A burn's public receipt, or null when the signature is not a finalized $MSKD burn. */
export async function burnReceipt(genesis: string, signature: string): Promise<BurnReceipt | null> {
  const mint = mskdBuybackMint(genesis);
  if (!mint) return null;
  const burn = await sharedRead(`burn:${genesis}:${signature}`, () =>
    store.burn(genesis, mint, signature)
  );
  if (!burn) return null;
  return {
    ...burn,
    supply: await sharedRead(`supply:${genesis}:${mint}`, () => tokenSupply(mint), 60_000),
  };
}

export const latestKeyImages = (genesis: string) =>
  sharedRead(`key-images:${genesis}`, () => store.latestKeyImages(genesis), 60_000);
