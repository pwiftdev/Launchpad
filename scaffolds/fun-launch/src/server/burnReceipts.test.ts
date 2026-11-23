import { afterAll, beforeAll, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { readBurnReceipts } from './burnReceipts';

const db = new PGlite();
const adapter = {
  query: (sql: string, parameters?: unknown[]) => db.query(sql, parameters),
} as Pick<Pool, 'query'>;
beforeAll(async () => {
  await db.exec(`CREATE TABLE financial_jobs(id int, network_genesis text, mint text, kind text,
    status text, expectations jsonb, received_tokens numeric, lamports numeric, signature text, finalized_slot bigint);
    CREATE TABLE wallet_jobs(id int,network_genesis text,mint text,kind text,status text,
      burned_tokens numeric,lamports numeric,signature text,finalized_slot bigint,
      expectations jsonb DEFAULT '{"effect":"buyback_burn"}',
      message_digest text DEFAULT repeat('a',64));
    CREATE TABLE wallet_settlements(job_id int,network_genesis text,mint text,kind text,
      signature text,message_digest text,finalized_slot bigint,
      actual_spent_lamports numeric,burned_tokens numeric);
    INSERT INTO financial_jobs SELECT n,'local','coin-a','buyback','finalized','{"effect":"buyback_burn"}',100,10,'receipt-'||n,n
    FROM generate_series(1,52) n;
    INSERT INTO financial_jobs VALUES
      (100,'other-network','coin-b','buyback','finalized','{"effect":"buyback_burn"}',100,999,'wrong-network',100),
      (101,'local','coin-b','buyback','submitted','{"effect":"buyback_burn"}',100,999,'pending',101),
      (102,'local','coin-b','buyback','finalized','{"effect":"buyback"}',100,999,'unburned',102),
      (103,'local','coin-b','buyback','finalized','{"effect":"buyback_burn"}',0,999,'empty',103),
      (104,'local','coin-b','buyback','finalized','{"effect":"buyback_burn"}',100,999,NULL,104),
      (105,'local','coin-b','buyback','finalized','{"effect":"buyback_burn"}',100,999,'unfinalized',NULL);`);
});
afterAll(() => db.close());
it('shows only verified atomic burns on this network, with complete totals and bounded recent receipts', async () => {
  const result = await readBurnReceipts('local', adapter);
  expect(result.totals).toEqual({ coins: '1', buybacks: '52', lamports: '520' });
  expect(result.receipts).toHaveLength(50);
  expect(result.receipts[0]?.signature).toBe('receipt-52');
  expect(result.receipts.at(-1)?.signature).toBe('receipt-3');
  expect(result.receipts.every((item) => item.tokenUnits === '100')).toBe(true);
});
it('includes standard-wallet finalized atomic burns and excludes pending or unburned payouts', async () => {
  await db.exec(`INSERT INTO wallet_jobs(id,network_genesis,mint,kind,status,burned_tokens,lamports,signature,finalized_slot) VALUES
    (1,'wallet-network','wallet-mint','buyback','finalized',123,456,'wallet-receipt',200),
    (2,'wallet-network','wallet-mint','buyback','submitted',123,999,'pending',201),
    (3,'wallet-network','wallet-mint','buyback','finalized',0,999,'unburned',202),
    (4,'wallet-network','wallet-mint','creator_claim','finalized',123,999,'wrong-kind',203),
    (5,'wallet-network','wallet-mint','buyback','finalized',123,999,NULL,204),
    (6,'wallet-network','wallet-mint','buyback','finalized',123,999,'missing-slot',NULL);
    INSERT INTO financial_jobs VALUES(200,'wallet-network','wallet-mint','buyback','finalized','{"effect":"buyback_burn"}',123,456,'wallet-receipt',200);
    INSERT INTO wallet_settlements SELECT id,network_genesis,mint,kind,signature,message_digest,
      finalized_slot,lamports,burned_tokens FROM wallet_jobs WHERE network_genesis='wallet-network';`);
  const result = await readBurnReceipts('wallet-network', adapter);
  expect(result.totals).toEqual({ coins: '1', buybacks: '1', lamports: '456' });
  expect(result.receipts).toEqual([
    {
      mint: 'wallet-mint',
      signature: 'wallet-receipt',
      finalizedSlot: '200',
      lamports: '456',
      tokenUnits: '123',
    },
  ]);
});
it('reports actual finalized spending and requires matching settlement evidence', async () => {
  await db.exec(`INSERT INTO wallet_jobs(id,network_genesis,mint,kind,status,burned_tokens,lamports,signature,finalized_slot)
    SELECT n,'actual-network','actual-mint','buyback','finalized',123,1000,'actual-'||n,300+n
    FROM generate_series(10,16) n;
    INSERT INTO wallet_settlements SELECT id,network_genesis,mint,kind,signature,message_digest,
      finalized_slot,900,burned_tokens FROM wallet_jobs WHERE network_genesis='actual-network' AND id<>11;
    UPDATE wallet_settlements SET signature='different' WHERE job_id=12;
    UPDATE wallet_settlements SET finalized_slot=0 WHERE job_id=13;
    UPDATE wallet_settlements SET burned_tokens=124 WHERE job_id=14;
    UPDATE wallet_settlements SET actual_spent_lamports=1001 WHERE job_id=15;
    UPDATE wallet_settlements SET message_digest=repeat('b',64) WHERE job_id=16;
    INSERT INTO financial_jobs VALUES(300,'actual-network','actual-mint','buyback','finalized',
      '{"effect":"buyback_burn"}',123,1000,'actual-10',310);`);
  const result = await readBurnReceipts('actual-network', adapter);
  expect(result.totals).toEqual({ coins: '1', buybacks: '1', lamports: '900' });
  expect(result.receipts).toEqual([
    {
      mint: 'actual-mint',
      signature: 'actual-10',
      finalizedSlot: '310',
      lamports: '900',
      tokenUnits: '123',
    },
  ]);
});

it('public burn receipts omit old policies while private history remains intact', async () => {
  await db.exec(`CREATE TABLE launch_coins(network_genesis text,mint text,policy_version text);
    INSERT INTO launch_coins VALUES ('public-network','old-mint','wallet-v1'),('public-network','new-mint','bond-v1');
    INSERT INTO wallet_jobs(id,network_genesis,mint,kind,status,burned_tokens,lamports,signature,finalized_slot) VALUES
      (301,'public-network','old-mint','buyback','finalized',100,1000,'old-burn',1000),
      (302,'public-network','new-mint','buyback','finalized',200,2000,'new-burn',1001);
    INSERT INTO wallet_settlements SELECT id,network_genesis,mint,kind,signature,message_digest,
      finalized_slot,lamports,burned_tokens FROM wallet_jobs WHERE network_genesis='public-network';`);
  const publicView = await readBurnReceipts('public-network', adapter, 'bond-v1');
  expect(publicView.totals).toEqual({ coins: '1', buybacks: '1', lamports: '2000' });
  expect(publicView.receipts.map((row) => row.mint)).toEqual(['new-mint']);
  expect((await readBurnReceipts('public-network', adapter)).receipts).toHaveLength(2);
});
