import type { Pool } from 'pg';
import { CHAT_PAGE_SIZE, type ChatFeed } from '@/lib/tokenChat';
import { chatRoom } from './chatSecurity';
import { database } from './database';

type StoredMessage = {
  id: string;
  author: string;
  client_id: string;
  ciphertext: Buffer;
  created_at: Date;
};

export class ChatStore {
  constructor(private db: Pick<Pool, 'query'> = database()) {}

  async feed(
    secret: Buffer,
    genesis: string,
    mint: string,
    wallet: string,
    before: string | null
  ): Promise<ChatFeed | null> {
    const room = chatRoom(secret, genesis, mint);
    const { rows } = await this.db.query<StoredMessage | { id: null }>(
      `SELECT entry.id::text,entry.author,entry.client_id,entry.ciphertext,entry.created_at
       FROM launch_coins coin LEFT JOIN LATERAL (
         SELECT id,author,client_id,ciphertext,created_at FROM token_chat_messages
         WHERE network_genesis=coin.network_genesis AND mint=coin.mint
           AND ($3::bigint IS NULL OR id<$3)
         ORDER BY id DESC LIMIT $4
       ) entry ON true
       WHERE coin.network_genesis=$1 AND coin.mint=$2 ORDER BY entry.id DESC`,
      [genesis, mint, before, CHAT_PAGE_SIZE + 1]
    );
    if (!rows.length) return null;
    const page = rows
      .filter((row): row is StoredMessage => row.id !== null)
      .slice(0, CHAT_PAGE_SIZE)
      .reverse();
    return {
      messages: page.map((row) => ({
        id: row.id,
        author: row.author,
        body: room.decrypt(row.author, row.client_id, row.ciphertext),
        createdAt: row.created_at.toISOString(),
      })),
      viewer: room.author(wallet),
      nextBefore: rows.length > CHAT_PAGE_SIZE ? page[0]!.id : null,
    };
  }

  async post(
    secret: Buffer,
    genesis: string,
    mint: string,
    wallet: string,
    clientId: string,
    body: string
  ) {
    const room = chatRoom(secret, genesis, mint);
    const author = room.author(wallet);
    await this.db.query(
      `INSERT INTO token_chat_messages(network_genesis,mint,author,client_id,ciphertext)
       VALUES($1,$2,$3,$4,$5) ON CONFLICT(network_genesis,mint,author,client_id) DO NOTHING`,
      [genesis, mint, author, clientId, room.encrypt(author, clientId, body)]
    );
  }
}
