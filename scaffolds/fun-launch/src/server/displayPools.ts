import type { AccountInfo, Connection, PublicKey } from '@solana/web3.js';
import {
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  type DynamicBondingCurveClient,
  type VirtualPool,
} from '@meteora-ag/dynamic-bonding-curve-sdk';

type State = Pick<DynamicBondingCurveClient['state'], 'getProgram' | 'getPoolsByConfig'>;
type Pool = { publicKey: PublicKey; account: VirtualPool };
type PoolIdentity = { publicKey: PublicKey; mint: PublicKey; config: PublicKey };
const DISCOVERY_MS = 5 * 60_000;
const ACCOUNT_BATCH = 100;

export function createDisplayPoolReader(
  rpc: Pick<Connection, 'getMultipleAccountsInfo'>,
  state: State
) {
  let directory: { key: string; at: number; pools: PoolIdentity[] } | undefined;
  let generation = 0;

  function decode(identity: PoolIdentity, info: AccountInfo<Buffer> | null | undefined) {
    if (!info || info.executable || !info.owner.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID))
      return null;
    const coder = state.getProgram().coder.accounts;
    for (const variant of ['virtualPool', 'transferHookPool']) {
      let account: VirtualPool;
      try {
        account = coder.decode<VirtualPool>(variant, info.data);
      } catch {
        continue;
      }
      return account.poolState.baseMint.equals(identity.mint) &&
        account.poolState.config.equals(identity.config)
        ? { publicKey: identity.publicKey, account }
        : null;
    }
    return null;
  }

  async function readKnown(pools: PoolIdentity[]): Promise<Pool[]> {
    const result: Pool[] = [];
    for (let offset = 0; offset < pools.length; offset += ACCOUNT_BATCH) {
      const batch = pools.slice(offset, offset + ACCOUNT_BATCH);
      const accounts = await rpc.getMultipleAccountsInfo(batch.map(({ publicKey }) => publicKey));
      if (accounts.length !== batch.length) throw new Error('Incomplete display pool batch');
      batch.forEach((identity, index) => {
        const pool = decode(identity, accounts[index]);
        if (pool) result.push(pool);
      });
    }
    return result;
  }

  return {
    async list(configs: PublicKey[]) {
      const key = configs.map((config) => config.toBase58()).join(':');
      if (directory?.key === key && Date.now() - directory.at < DISCOVERY_MS) {
        const known = directory.pools;
        const pools = await readKnown(known);
        if (pools.length === known.length) return pools;
      }

      const started = generation;
      const pools: Pool[] = [];
      for (const config of configs) pools.push(...(await state.getPoolsByConfig(config)));
      if (started === generation)
        directory = {
          key,
          at: Date.now(),
          pools: pools.map(({ publicKey, account }) => ({
            publicKey,
            mint: account.poolState.baseMint,
            config: account.poolState.config,
          })),
        };
      return pools;
    },
    async read(identity: PoolIdentity) {
      return (await readKnown([identity]))[0] ?? null;
    },
    invalidate() {
      generation++;
      directory = undefined;
    },
  };
}
