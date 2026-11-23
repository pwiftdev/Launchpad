import { afterEach, describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import type { PoolConfig } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { vaultAddresses } from '@/lib/vault/client';
import owner from '../../../../docs/mainnet-authorities.public.json';
import {
  NETWORK_GENESIS,
  verifyLaunchConfig,
  verifiedGenesis,
  assertConfigApproval,
  configuredCompanyWallets,
  discoverableConfigKeys,
} from './launchConfig';

const registry = vi.hoisted(() => ({ registeredConfig: vi.fn(), registeredConfigKeys: vi.fn() }));
vi.mock('./launchRegistry', () => registry);
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
function fixture(legacy = false) {
  const feeClaimer = Keypair.generate().publicKey,
    treasury = Keypair.generate().publicKey,
    key = Keypair.generate().publicKey;
  vi.stubEnv('FEE_COLLECTOR_PUBLIC_KEY', feeClaimer.toBase58());
  vi.stubEnv('TREASURY_PUBLIC_KEY', treasury.toBase58());
  vi.stubEnv('VAULT_PROGRAM_ID', '');
  vi.stubEnv('NEXT_PUBLIC_VAULT_PROGRAM_ID', '');
  const config = {
    quoteMint: new PublicKey('So11111111111111111111111111111111111111112'),
    feeClaimer,
    leftoverReceiver: treasury,
    poolFees: {
      baseFee: {
        cliffFeeNumerator: 900000000n,
        firstFactor: 9,
        secondFactor: 3n,
        thirdFactor: 3782n,
        baseFeeMode: 1,
      },
      dynamicFee: { initialized: 0 },
    },
    collectFeeMode: 0,
    activationType: 1,
    tokenDecimal: 6,
    tokenType: 0,
    tokenUpdateAuthority: 1,
    preMigrationTokenSupply: 1000000000000000n,
    postMigrationTokenSupply: 1000000000000000n,
    migrationQuoteThreshold: 80000000000n,
    migrationOption: 1,
    migrationFeeOption: 6,
    migratedCollectFeeMode: 0,
    migratedDynamicFee: 0,
    migratedPoolFeeBps: 125,
    migratedPoolBaseFeeMode: 0,
    creatorTradingFeePercentage: 0,
    partnerLiquidityPercentage: 0,
    creatorLiquidityPercentage: 0,
    partnerPermanentLockedLiquidityPercentage: 100,
    creatorPermanentLockedLiquidityPercentage: 0,
    poolCreationFee: 0n,
    migrationFeePercentage: 0,
    creatorMigrationFeePercentage: 0,
  } as unknown as PoolConfig;
  const record = {
    network_genesis: NETWORK_GENESIS.devnet,
    config_key: key.toBase58(),
    enabled_for_launch: true,
    policy_version: legacy ? 'wallet-v1' : 'bond-v1',
    config_digest: 'a'.repeat(64),
    expected_fee_claimer: feeClaimer.toBase58(),
    expected_leftover_receiver: treasury.toBase58(),
  };
  if (!legacy) {
    Object.assign(config, {
      activationType: 0,
      enableFirstSwapWithMinFee: true,
      migratedPoolFeeBps: 100,
    });
    Object.assign(config.poolFees.baseFee, {
      cliffFeeNumerator: 990000000n,
      baseFeeMode: 0,
      firstFactor: 1,
      secondFactor: 1n,
      thirdFactor: 977500000n,
    });
  }
  registry.registeredConfig.mockResolvedValue(record);
  return { key, config, record };
}
describe('runtime configuration admission', () => {
  it('public discovery ignores old environment keys and selects only Bond it. registry records', async () => {
    const old = Keypair.generate().publicKey.toBase58();
    const current = Keypair.generate().publicKey.toBase58();
    vi.stubEnv('POOL_CONFIG_KEY', old);
    vi.stubEnv('LEGACY_POOL_CONFIG_KEYS', old);
    registry.registeredConfigKeys.mockResolvedValue([current, current]);
    await expect(discoverableConfigKeys(NETWORK_GENESIS['mainnet-beta'])).resolves.toEqual([
      current,
    ]);
    expect(registry.registeredConfigKeys).toHaveBeenCalledWith(
      NETWORK_GENESIS['mainnet-beta'],
      'bond-v1'
    );
  });

  it('public discovery stays empty when only historical configs exist', async () => {
    vi.stubEnv('POOL_CONFIG_KEY', Keypair.generate().publicKey.toBase58());
    registry.registeredConfigKeys.mockResolvedValue([]);
    await expect(discoverableConfigKeys(NETWORK_GENESIS['mainnet-beta'])).resolves.toEqual([]);
  });
  it('verifies historical wallet config without redirecting it to the new active collector', async () => {
    const { key, config, record } = fixture(true);
    const old = owner.legacyCompanyWallets[0]!;
    config.feeClaimer = new PublicKey(old.collector);
    config.leftoverReceiver = new PublicKey(old.treasury);
    Object.assign(record, {
      network_genesis: NETWORK_GENESIS['mainnet-beta'],
      expected_fee_claimer: old.collector,
      expected_leftover_receiver: old.treasury,
    });
    vi.stubEnv('FEE_COLLECTOR_PUBLIC_KEY', owner.company.collector);
    vi.stubEnv('TREASURY_PUBLIC_KEY', owner.company.treasury);
    await expect(
      verifyLaunchConfig(
        NETWORK_GENESIS['mainnet-beta'],
        key,
        config,
        record.config_digest,
        'creator',
        { allowLegacy: true }
      )
    ).resolves.toEqual(record);
    expect(config.feeClaimer.toBase58()).toBe(old.collector);
    await expect(
      verifyLaunchConfig(
        NETWORK_GENESIS['mainnet-beta'],
        key,
        config,
        record.config_digest,
        'creator'
      )
    ).rejects.toThrow('reviewed');
  });
  it('never applies historical wallet opt-in to a new Bond it. configuration', async () => {
    const { key, config, record } = fixture();
    const old = owner.legacyCompanyWallets[0]!;
    config.feeClaimer = new PublicKey(old.collector);
    config.leftoverReceiver = new PublicKey(old.treasury);
    Object.assign(record, {
      network_genesis: NETWORK_GENESIS['mainnet-beta'],
      expected_fee_claimer: old.collector,
      expected_leftover_receiver: old.treasury,
    });
    vi.stubEnv('FEE_COLLECTOR_PUBLIC_KEY', old.collector);
    vi.stubEnv('TREASURY_PUBLIC_KEY', old.treasury);
    await expect(
      verifyLaunchConfig(
        NETWORK_GENESIS['mainnet-beta'],
        key,
        config,
        record.config_digest,
        'bond',
        { allowLegacy: true }
      )
    ).rejects.toThrow('owner-provided');
  });
  it('requires native approval of the exact configuration bytes and version', () => {
    const key = Keypair.generate().publicKey,
      digest = 'a'.repeat(64),
      data = Buffer.alloc(74);
    data.write('RCONF001');
    data[8] = 1;
    key.toBuffer().copy(data, 10);
    Buffer.from(digest, 'hex').copy(data, 42);
    expect(() => assertConfigApproval(data, key, digest)).not.toThrow();
    expect(() => assertConfigApproval(data, key, 'b'.repeat(64))).toThrow();
    expect(() => assertConfigApproval(data, Keypair.generate().publicKey, digest)).toThrow();
    data[8] = 2;
    expect(() => assertConfigApproval(data, key, digest)).toThrow();
  });
  it('requires reviewed ordinary company wallets for new modes without any native deployment', async () => {
    const { key, config, record } = fixture();
    await expect(
      verifyLaunchConfig(NETWORK_GENESIS.devnet, key, config, record.config_digest, 'bond')
    ).resolves.toEqual(record);
    await expect(
      verifyLaunchConfig(NETWORK_GENESIS.devnet, key, config, 'b'.repeat(64), 'bond')
    ).rejects.toThrow('differs');
    registry.registeredConfig.mockResolvedValue(null);
    await expect(
      verifyLaunchConfig(NETWORK_GENESIS.devnet, key, config, record.config_digest, 'bond')
    ).rejects.toThrow('reviewed');
  });
  it('rejects redirecting immutable collector to another wallet even if the DB record was substituted', async () => {
    const { key, config, record } = fixture(),
      wallet = Keypair.generate().publicKey;
    registry.registeredConfig.mockResolvedValue({
      ...record,
      expected_fee_claimer: wallet.toBase58(),
    });
    await expect(
      verifyLaunchConfig(
        NETWORK_GENESIS.devnet,
        key,
        { ...config, feeClaimer: wallet },
        record.config_digest,
        'bond'
      )
    ).rejects.toThrow('company wallet');
  });
  it('rejects parallel creator LP rights and extra fees', async () => {
    const { key, config, record } = fixture();
    for (const changed of [
      {
        partnerPermanentLockedLiquidityPercentage: 50,
        creatorPermanentLockedLiquidityPercentage: 50,
      },
      { poolCreationFee: 20_000_000n },
      { creatorTradingFeePercentage: 50 },
    ])
      await expect(
        verifyLaunchConfig(
          NETWORK_GENESIS.devnet,
          key,
          { ...config, ...changed } as PoolConfig,
          record.config_digest,
          'bond'
        )
      ).rejects.toThrow();
  });
  it('does not prepare mode-less legacy launches on any network', async () => {
    vi.stubEnv('LAUNCH_POLICY_VERSION', '');
    const { key, config } = fixture();
    registry.registeredConfig.mockResolvedValue(null);
    await expect(
      verifyLaunchConfig(NETWORK_GENESIS.devnet, key, config, 'a'.repeat(64))
    ).rejects.toThrow('reviewed');
    await expect(
      verifyLaunchConfig(NETWORK_GENESIS['mainnet-beta'], key, config, 'a'.repeat(64))
    ).rejects.toThrow();
  });
  it('confirms legacy native policy only via explicit legacy opt-in while never preparing another native launch', async () => {
    const { key, config, record } = fixture(true),
      program = Keypair.generate().publicKey,
      feeClaimer = vaultAddresses(program, PublicKey.default).feeAuthority;
    vi.stubEnv('VAULT_PROGRAM_ID', program.toBase58());
    vi.stubEnv('NEXT_PUBLIC_VAULT_PROGRAM_ID', program.toBase58());
    const legacy = {
      ...record,
      policy_version: 'rinse-v1',
      expected_fee_claimer: feeClaimer.toBase58(),
    };
    registry.registeredConfig.mockResolvedValue(legacy);
    await expect(
      verifyLaunchConfig(
        NETWORK_GENESIS.devnet,
        key,
        { ...config, feeClaimer },
        record.config_digest,
        'creator'
      )
    ).rejects.toThrow('reviewed');
    await expect(
      verifyLaunchConfig(
        NETWORK_GENESIS.devnet,
        key,
        { ...config, feeClaimer },
        record.config_digest,
        'creator',
        { allowLegacy: true }
      )
    ).resolves.toEqual(legacy);
  });
  it('refuses native PDA destinations, missing explicit wallets, and mainnet wallet aliases', () => {
    fixture();
    const pda = vaultAddresses(Keypair.generate().publicKey, PublicKey.default).feeAuthority;
    vi.stubEnv('FEE_COLLECTOR_PUBLIC_KEY', pda.toBase58());
    expect(() => configuredCompanyWallets(NETWORK_GENESIS.devnet)).toThrow('ordinary');
    vi.stubEnv('FEE_COLLECTOR_PUBLIC_KEY', '');
    expect(() => configuredCompanyWallets(NETWORK_GENESIS.devnet)).toThrow('Explicit');
    fixture();
    expect(() => configuredCompanyWallets(NETWORK_GENESIS['mainnet-beta'])).toThrow(
      'owner-provided'
    );
    vi.stubEnv('FEE_COLLECTOR_PUBLIC_KEY', '3j4vUdPKF7HNqKoaWdezQoX9Hognn6Us7ua6thZZiaed');
    vi.stubEnv('TREASURY_PUBLIC_KEY', 'GfgpgQa2ZqNm17rJ6fw2t5nBApKKPZBn5M5niWW3riZZ');
    expect(configuredCompanyWallets(NETWORK_GENESIS['mainnet-beta']).collector.toBase58()).toBe(
      process.env.FEE_COLLECTOR_PUBLIC_KEY
    );
  });
  it('checks actual genesis instead of trusting the configured network name', async () => {
    vi.stubEnv('NEXT_PUBLIC_NETWORK', 'devnet');
    const connection = {
      getGenesisHash: vi.fn().mockResolvedValue(NETWORK_GENESIS['mainnet-beta']),
    };
    await expect(verifiedGenesis(connection)).rejects.toThrow('genesis');
    connection.getGenesisHash.mockResolvedValue(NETWORK_GENESIS.devnet);
    await expect(verifiedGenesis(connection)).resolves.toBe(NETWORK_GENESIS.devnet);
  });
});
