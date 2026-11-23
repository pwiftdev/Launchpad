import { Connection, PublicKey } from '@solana/web3.js';
import { epochAddress, vaultAddresses } from '@/lib/vault/client';
import { decodeVaultCoin, decodeVaultEpoch, decodeVaultSettings } from '@/lib/vault/state';

export async function readVaultCoin(rpc: Connection, programId: PublicKey, mint: PublicKey) {
  const addresses = vaultAddresses(programId, mint);
  const result = await rpc.getAccountInfoAndContext(addresses.coin, 'finalized');
  if (!result.value || !result.value.owner.equals(programId))
    throw new Error('Funded vault is not available');
  const state = decodeVaultCoin(result.value.data);
  if (!state.mint.equals(mint)) throw new Error('Vault mint mismatch');
  return { state, slot: result.context.slot, addresses };
}
export async function readVaultEpoch(
  rpc: Connection,
  programId: PublicKey,
  mint: PublicKey,
  epoch: bigint
) {
  const { coin } = vaultAddresses(programId, mint),
    address = epochAddress(programId, coin, epoch);
  const result = await rpc.getAccountInfoAndContext(address, 'finalized');
  if (!result.value || !result.value.owner.equals(programId))
    throw new Error('Epoch is not funded');
  const state = decodeVaultEpoch(result.value.data);
  if (!state.coin.equals(coin) || state.epoch !== epoch || state.remaining > state.total)
    throw new Error('Epoch does not match the claim');
  return { state, address, slot: result.context.slot };
}
export async function readVaultEpochs(
  rpc: Connection,
  programId: PublicKey,
  mint: PublicKey,
  epochs: bigint[]
) {
  if (epochs.length > 20) throw new Error('Reward page exceeds verification capacity');
  const output = new Map<string, ReturnType<typeof decodeVaultEpoch>>();
  if (!epochs.length) return output;
  const { coin } = vaultAddresses(programId, mint);
  const accounts = await rpc.getMultipleAccountsInfo(
    epochs.map((epoch) => epochAddress(programId, coin, epoch)),
    'finalized'
  );
  epochs.forEach((epoch, index) => {
    const account = accounts[index];
    if (!account?.owner.equals(programId)) throw new Error('Epoch is not funded');
    const state = decodeVaultEpoch(account.data);
    if (!state.coin.equals(coin) || state.epoch !== epoch || state.remaining > state.total)
      throw new Error('Epoch does not match the claim');
    output.set(epoch.toString(), state);
  });
  return output;
}
export async function readVaultSettings(rpc: Connection, programId: PublicKey) {
  const [address] = PublicKey.findProgramAddressSync([Buffer.from('settings')], programId);
  const account = await rpc.getAccountInfo(address, 'finalized');
  if (!account || !account.owner.equals(programId))
    throw new Error('Vault settings are unavailable');
  return decodeVaultSettings(account.data);
}
