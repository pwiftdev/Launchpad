import type { Database, Queryable } from './store';

export function leaseDatabase(client: Queryable) {
  let active = true;
  let tail = Promise.resolve();
  const assertActive = () => {
    if (!active) throw new Error('Display indexer lease lost');
  };
  const query: Queryable['query'] = async (sql, values) => {
    assertActive();
    return client.query(sql, values);
  };
  const connect = async () => {
    assertActive();
    const turn = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => (release = resolve));
    await turn;
    if (!active) {
      release();
      assertActive();
    }
    return { query, release };
  };
  const db: Database = {
    connect,
    async query(sql, values) {
      const session = await connect();
      try {
        return await session.query(sql, values);
      } finally {
        session.release();
      }
    },
  };
  return { db, close: () => (active = false) };
}
