import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import {
  ringsAddress,
  ringsState,
  type RingsAttempt,
  type RingsFunding,
  type RingsPartial,
  type RingsRoom,
  type RingsRoomLink,
  type RingsSide,
} from '@/lib/otcRingsRoom';
import { database } from './database';
import { OtcStore, otcTerms } from './otcStore';
import { derivePrivateKey, openPrivate, sealPrivate } from './privateEncryption';
import { SocialError } from './profileStore';

const packet = ringsState.extend({
  terms: otcTerms,
  expiresAt: z.iso.datetime(),
  origin: z.string().url(),
  localUsdc: ringsAddress.optional(),
});
type Packet = Omit<RingsRoom, 'id' | 'genesis' | 'side'>;
type Row = { id: string; maker: string; taker: string; revision: string; ciphertext: Buffer };
const columns = 'offer_id AS id,maker,taker,revision::text,ciphertext';
const emptyParty = (): RingsRoom['maker'] => ({
  key: null,
  funding: null,
  proof: null,
  withdrawal: null,
  reserve: null,
});
const missing = () => new SocialError('This OTC deal is unavailable.', 404);
const conflict = () => new SocialError('The deal changed. Refresh and try again.', 409);

type Mutation =
  | { action: 'key'; key: string }
  | { action: 'funding'; funding: RingsFunding }
  | { action: 'proof'; proof: string }
  | { action: 'attempt'; lifetime: RingsAttempt['lifetime'] }
  | { action: 'sign'; attempt: string; partial: RingsPartial }
  | { action: 'retry-funding'; signature: string }
  | { action: 'withdrawal'; withdrawal: RingsFunding }
  | { action: 'retry-withdrawal'; signature: string }
  | { action: 'reserve'; reserve: RingsFunding }
  | { action: 'retry-reserve'; signature: string }
  | { action: 'retry-attempt'; attempt: string };

export class OtcRingsStore {
  private readonly key: Buffer;
  constructor(
    private readonly secret: Buffer,
    private readonly genesis: string,
    private readonly db: Pick<Pool, 'query'> = database()
  ) {
    this.key = derivePrivateKey(secret, 'mskd-confidential-otc/v1/rings-deal');
  }

  private context(row: Pick<Row, 'id' | 'maker' | 'taker'>) {
    return JSON.stringify([this.genesis, row.id, row.maker, row.taker]);
  }

  private open(row: Row) {
    return packet.parse(
      JSON.parse(openPrivate(this.key, this.context(row), row.ciphertext))
    ) as Packet;
  }

  private view(row: Row, state: Packet, wallet: string): RingsRoom {
    return {
      ...state,
      genesis: this.genesis,
      id: row.id,
      side: row.maker === wallet ? 'maker' : 'taker',
    };
  }

  private async row(id: string, wallet: string) {
    const { rows } = await this.db.query<Row>(
      `SELECT ${columns} FROM otc_rings_deals WHERE network_genesis=$1 AND offer_id=$2 AND (maker=$3 OR taker=$3)`,
      [this.genesis, id, wallet]
    );
    return rows[0];
  }

  async get(id: string, wallet: string) {
    const row = await this.row(id, wallet);
    if (!row) throw missing();
    return this.view(row, this.open(row), wallet);
  }

  async openDeal(id: string, wallet: string, origin: string, localUsdc?: string) {
    const row = await this.row(id, wallet);
    if (row) return this.view(row, this.open(row), wallet);
    const { maker, taker, terms, expiresAt } = await new OtcStore(
      this.secret,
      this.genesis,
      this.db
    ).acceptedDeal(id, wallet);
    const state: Packet = {
      terms,
      expiresAt,
      origin,
      localUsdc,
      maker: emptyParty(),
      taker: emptyParty(),
      attempt: null,
    };
    const ciphertext = sealPrivate(
      this.key,
      this.context({ id, maker, taker }),
      JSON.stringify(state)
    );
    await this.db.query(
      `INSERT INTO otc_rings_deals(offer_id,network_genesis,maker,taker,ciphertext)
       SELECT id,network_genesis,$3::varchar(44),$4::varchar(44),$5::bytea FROM confidential_otc_offers
       WHERE network_genesis=$1 AND id=$2 AND owner=$3 AND expires_at>now()
       ON CONFLICT (offer_id) DO NOTHING`,
      [this.genesis, id, maker, taker, ciphertext]
    );
    return this.get(id, wallet);
  }

  async list(wallet: string): Promise<RingsRoomLink[]> {
    const { rows } = await this.db.query<Row>(
      `SELECT ${columns} FROM otc_rings_deals WHERE network_genesis=$1 AND (maker=$2 OR taker=$2)
       ORDER BY created_at DESC LIMIT 100`,
      [this.genesis, wallet]
    );
    return rows.map((row) => {
      const { terms, expiresAt } = this.open(row);
      return { id: row.id, side: row.maker === wallet ? 'maker' : 'taker', terms, expiresAt };
    });
  }

  async mutate(id: string, wallet: string, change: Mutation) {
    const row = await this.row(id, wallet);
    if (!row) throw missing();
    const state = this.open(row);
    const side = row.maker === wallet ? 'maker' : 'taker';
    if (!applyChange(state, side, change)) return this.view(row, state, wallet);
    const ciphertext = sealPrivate(
      this.key,
      this.context(row),
      JSON.stringify(packet.parse(state))
    );
    const result = await this.db.query(
      `UPDATE otc_rings_deals SET revision=revision+1,ciphertext=$4
       WHERE network_genesis=$1 AND offer_id=$2 AND revision=$3 RETURNING revision`,
      [this.genesis, id, row.revision, ciphertext]
    );
    if (!result.rows.length) throw conflict();
    return this.view(row, state, wallet);
  }
}

function applyChange(state: Packet, side: RingsSide, change: Mutation) {
  const own = state[side];
  const expired = Date.parse(state.expiresAt) <= Date.now();
  if (change.action === 'reserve') {
    if (own.reserve?.signature === change.reserve.signature) return false;
    if (!own.withdrawal || own.reserve) throw conflict();
    own.reserve = change.reserve;
    return true;
  }
  if (change.action === 'retry-reserve') {
    if (own.reserve?.signature !== change.signature) throw conflict();
    own.reserve = null;
    return true;
  }
  if (change.action === 'withdrawal') {
    if (own.withdrawal?.signature === change.withdrawal.signature) return false;
    if (
      !own.funding ||
      own.withdrawal ||
      (!expired && !(state.attempt?.maker && state.attempt.taker))
    )
      throw conflict();
    own.withdrawal = change.withdrawal;
    return true;
  }
  if (change.action === 'retry-withdrawal') {
    if (own.withdrawal?.signature !== change.signature) throw conflict();
    own.withdrawal = null;
    return true;
  }
  if (expired) throw new SocialError('This OTC deal has expired.', 409);
  const both = state.maker.key && state.taker.key;
  switch (change.action) {
    case 'key':
      if (own.key === change.key) return false;
      if (own.key || state.maker.key === change.key || state.taker.key === change.key)
        throw conflict();
      own.key = change.key;
      return true;
    case 'funding':
      if (own.funding?.signature === change.funding.signature) return false;
      if (!both || own.funding) throw conflict();
      own.funding = change.funding;
      return true;
    case 'proof':
      if (own.proof === change.proof) return false;
      if (!state.maker.funding || !state.taker.funding || state.attempt) throw conflict();
      own.proof = change.proof;
      return true;
    case 'attempt':
      if (state.attempt) return false;
      if (!state.maker.proof || !state.taker.proof) throw conflict();
      state.attempt = { id: randomUUID(), lifetime: change.lifetime, maker: null, taker: null };
      return true;
    case 'sign':
      if (state.attempt?.id !== change.attempt) throw conflict();
      if (state.attempt[side]?.signature === change.partial.signature) return false;
      if (state.attempt[side]) throw conflict();
      if (
        [state.attempt.maker, state.attempt.taker].some(
          (prior) => prior && prior.message !== change.partial.message
        )
      )
        throw conflict();
      state.attempt[side] = change.partial;
      return true;
    case 'retry-funding':
      if (own.funding?.signature !== change.signature || own.proof || state.attempt)
        throw conflict();
      own.funding = null;
      state.maker.proof = state.taker.proof = null;
      return true;
    case 'retry-attempt':
      if (state.attempt?.id !== change.attempt) throw conflict();
      state.attempt = null;
      state.maker.proof = state.taker.proof = null;
      return true;
  }
}
