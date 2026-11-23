import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

const databaseMock = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('./database', () => ({ database: () => databaseMock }));
import { registeredConfigKeys } from './launchRegistry';

let db: PGlite;
beforeAll(async () => {
  vi.stubEnv('DATABASE_URL', 'postgresql://fixture/fixture');
  db = new PGlite();
  await db.exec(`CREATE TABLE launch_configs(network_genesis text, config_key text, policy_version text);
    INSERT INTO launch_configs VALUES
      ('mainnet','old-rinse','rinse-v1'), ('mainnet','old-wallet','wallet-v1'),
      ('mainnet','new-bond','bond-v1'), ('devnet','other-network','bond-v1');`);
  databaseMock.query.mockImplementation((sql: string, args: unknown[]) => db.query(sql, args));
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await db.close();
});

it('hides historical configs from public discovery without deleting private history', async () => {
  await expect(registeredConfigKeys('mainnet', 'bond-v1')).resolves.toEqual(['new-bond']);
  await expect(registeredConfigKeys('mainnet')).resolves.toEqual([
    'new-bond',
    'old-rinse',
    'old-wallet',
  ]);
  expect((await db.query('SELECT count(*)::int AS count FROM launch_configs')).rows).toEqual([
    { count: 4 },
  ]);
});
