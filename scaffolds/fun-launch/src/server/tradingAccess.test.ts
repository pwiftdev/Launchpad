import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import type { NextApiResponse } from 'next';
import { allowTrading, verifiedTradingAccess } from './tradingAccess';
import { NETWORK_GENESIS } from '../../../../scripts/network-policy.cjs';
const rpc = vi.hoisted(() => ({ getGenesisHash: vi.fn(), getLaunchConfig: vi.fn() }));
vi.mock('./dbc', () => ({ connection: rpc, getLaunchConfig: rpc.getLaunchConfig }));
const response = () => {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return res as unknown as NextApiResponse;
};
function admitted(genesis = NETWORK_GENESIS.devnet) {
  rpc.getGenesisHash.mockResolvedValue(genesis);
  rpc.getLaunchConfig.mockResolvedValue({
    genesis,
    record: { policy_version: 'bond-v1', enabled_for_launch: true },
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  rpc.getGenesisHash.mockReset();
  rpc.getLaunchConfig.mockReset();
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('NEXT_PUBLIC_NETWORK', 'devnet');
  vi.stubEnv('SOLANA_NETWORK', '');
  vi.stubEnv('MAINNET_TRADING_ENABLED', '');
  vi.stubEnv('LOCAL_VALIDATOR_ENABLED', '');
  vi.stubEnv('LOCAL_VALIDATOR_GENESIS_HASH', '');
  vi.stubEnv('NEXT_PUBLIC_LOCAL_VALIDATOR_RPC_URL', '');
  vi.stubEnv('SITE_ALLOWED_ORIGINS', '');
  vi.stubEnv('FEE_COLLECTOR_PUBLIC_KEY', '3j4vUdPKF7HNqKoaWdezQoX9Hognn6Us7ua6thZZiaed');
  vi.stubEnv('TREASURY_PUBLIC_KEY', 'GfgpgQa2ZqNm17rJ6fw2t5nBApKKPZBn5M5niWW3riZZ');
  vi.stubEnv('VAULT_PROGRAM_ID', '');
  vi.stubEnv('NEXT_PUBLIC_VAULT_PROGRAM_ID', '');
  admitted();
});
afterEach(() => vi.unstubAllEnvs());
describe('wallet policy financial rollout gate', () => {
  it.each(['dev','cashback','mskd'] as const)('admits the reviewed %s config on devnet only', async mode => {
    for (const network of ['devnet','mainnet-beta'] as const) {
      vi.stubEnv('NEXT_PUBLIC_NETWORK', network);
      vi.stubEnv('MAINNET_TRADING_ENABLED', 'true');
      rpc.getGenesisHash.mockResolvedValue(NETWORK_GENESIS[network]);
      rpc.getLaunchConfig.mockResolvedValue({ genesis: NETWORK_GENESIS[network], record: {policy_version: mode + '-v1', enabled_for_launch:true} });
      expect(await allowTrading(response(), mode)).toBe(network === 'devnet');
    }
  });
  it('allows verified devnet wallet policy without requiring a custom program', async () => {
    const res = response();
    expect(await allowTrading(res)).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
    expect(rpc.getLaunchConfig).toHaveBeenCalledWith('bond');
    expect(rpc.getGenesisHash).toHaveBeenCalledTimes(2);
    await expect(verifiedTradingAccess('community')).rejects.toThrow('Only Bond it.');
    await verifiedTradingAccess('bond');
    expect(rpc.getLaunchConfig).toHaveBeenLastCalledWith('bond');
  });
  it('keeps mainnet closed by default and requires exact explicit true plus actual mainnet genesis', async () => {
    vi.stubEnv('NEXT_PUBLIC_NETWORK', 'mainnet-beta');
    admitted(NETWORK_GENESIS['mainnet-beta']);
    for (const flag of ['', 'false', 'TRUE', '1']) {
      vi.stubEnv('MAINNET_TRADING_ENABLED', flag);
      expect(await allowTrading(response())).toBe(false);
    }
    vi.stubEnv('MAINNET_TRADING_ENABLED', 'true');
    expect(await allowTrading(response())).toBe(true);
    admitted(NETWORK_GENESIS.devnet);
    expect(await allowTrading(response())).toBe(false);
  });
  it('rejects mainnet fee-wallet aliases despite the enable flag and a reviewed config', async () => {
    vi.stubEnv('NEXT_PUBLIC_NETWORK', 'mainnet-beta');
    vi.stubEnv('MAINNET_TRADING_ENABLED', 'true');
    admitted(NETWORK_GENESIS['mainnet-beta']);
    vi.stubEnv('FEE_COLLECTOR_PUBLIC_KEY', Keypair.generate().publicKey.toBase58());
    expect(await allowTrading(response())).toBe(false);
  });
  it('requires enabled reviewed wallet-v1 and refuses legacy native policy or failed config verification', async () => {
    for (const record of [
      { policy_version: 'rinse-v1', enabled_for_launch: true },
      { policy_version: 'bond-v1', enabled_for_launch: false },
      null,
    ]) {
      rpc.getLaunchConfig.mockResolvedValue({ genesis: NETWORK_GENESIS.devnet, record });
      expect(await allowTrading(response())).toBe(false);
    }
    rpc.getLaunchConfig.mockRejectedValue(new Error('Unreviewed account'));
    expect(await allowTrading(response())).toBe(false);
    admitted();
    vi.stubEnv('FEE_COLLECTOR_PUBLIC_KEY', '');
    expect(await allowTrading(response())).toBe(false);
  });
  it('rejects wrong genesis, post-verification drift and contradictory network aliases', async () => {
    rpc.getGenesisHash.mockResolvedValue('different-chain');
    expect(await allowTrading(response())).toBe(false);
    admitted();
    rpc.getGenesisHash
      .mockResolvedValueOnce(NETWORK_GENESIS.devnet)
      .mockResolvedValueOnce('another-chain');
    expect(await allowTrading(response())).toBe(false);
    admitted();
    vi.stubEnv('SOLANA_NETWORK', 'mainnet-beta');
    expect(await allowTrading(response())).toBe(false);
  });
  it('allows only independently pinned loopback local validators and rejects production/remote/public overrides', async () => {
    vi.stubEnv('NEXT_PUBLIC_NETWORK', 'localnet');
    vi.stubEnv('LOCAL_VALIDATOR_ENABLED', 'true');
    vi.stubEnv('LOCAL_VALIDATOR_GENESIS_HASH', '11111111111111111111111111111111');
    vi.stubEnv('RPC_URL', 'http://127.0.0.1:8899');
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'http://localhost:3002');
    admitted('11111111111111111111111111111111');
    expect(await allowTrading(response())).toBe(true);
    rpc.getGenesisHash.mockResolvedValue('wrong-local-chain');
    expect(await allowTrading(response())).toBe(false);
    admitted('11111111111111111111111111111111');
    vi.stubEnv('NODE_ENV', 'production');
    expect(await allowTrading(response())).toBe(false);
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('RPC_URL', 'https://api.mainnet.solana.com');
    expect(await allowTrading(response())).toBe(false);
    vi.stubEnv('RPC_URL', 'http://127.0.0.1:8899');
    vi.stubEnv('LOCAL_VALIDATOR_GENESIS_HASH', NETWORK_GENESIS['mainnet-beta']);
    expect(await allowTrading(response())).toBe(false);
  });
});
