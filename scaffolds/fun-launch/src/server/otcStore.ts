import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import {
  OTC_ASSETS,
  normalizeOtcAmount,
  otcAcceptanceMessage,
  otcLegAsset,
  type OtcExpiry,
  type OtcTerms,
  type OwnedOtcOffer,
  type ViewedOtcOffer,
} from '@/lib/otc';
import { database } from './database';
import { derivePrivateKey, openPrivate, sealPrivate } from './privateEncryption';
import { SocialError, socialSignature, socialWallet } from './profileStore';
import { verifyWalletMessage } from './verifyWalletMessage';

export const otcToken = z.strictObject({
  mint: socialWallet,
  symbol: z
    .string()
    .min(1)
    .max(18)
    .regex(/^[\p{L}\p{N}._$-]+$/u),
  decimals: z.number().int().min(0).max(9),
  program: z.enum(['spl', 'token-2022']),
});
const leg = z.discriminatedUnion('asset', [
  z.strictObject({ asset: z.enum(OTC_ASSETS), amount: z.string().max(30) }),
  z.strictObject({ asset: z.literal('TOKEN'), amount: z.string().max(30), token: otcToken }),
]);
export const otcTerms = z
  .strictObject({ sell: leg, buy: leg })
  .transform(({ sell, buy }, context): OtcTerms => {
    const sellAmount = normalizeOtcAmount(otcLegAsset(sell), sell.amount);
    const buyAmount = normalizeOtcAmount(otcLegAsset(buy), buy.amount);
    if (!sellAmount || !buyAmount || sell.asset === buy.asset) {
      context.addIssue({ code: 'custom', message: 'Invalid offer terms' });
      return z.NEVER;
    }
    return {
      sell: { ...sell, amount: sellAmount },
      buy: { ...buy, amount: buyAmount },
    };
  });

const offerContents = z.union([
  z.strictObject({
    terms: otcTerms,
    acceptance: z.strictObject({
      wallet: socialWallet,
      signature: socialSignature,
      origin: z.string().max(255),
      expiresAt: z.iso.datetime(),
    }),
  }),
  otcTerms.transform<{ terms: OtcTerms; acceptance: null }>((terms) => ({
    terms,
    acceptance: null,
  })),
]);
type OfferContents = z.output<typeof offerContents>;

type OfferRow = {
  id: string;
  owner: string;
  viewerWallet: string | null;
  expiresAt: Date;
  ciphertext: Buffer | null;
};

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const projection = 'id,owner,viewer_wallet AS "viewerWallet",expires_at AS "expiresAt"';

export class OtcStore {
  private key: Buffer;
  constructor(
    secret: Buffer,
    private genesis: string,
    private db: Pick<Pool, 'query'> = database()
  ) {
    this.key = derivePrivateKey(secret, 'mskd-confidential-otc/v1/terms');
  }

  private context(id: string, owner: string, viewer: string | null) {
    return JSON.stringify([this.genesis, id, owner, viewer]);
  }

  private contents(row: OfferRow): OfferContents {
    if (!row.ciphertext) throw new Error('OTC terms are unavailable');
    const contents = offerContents.parse(
      JSON.parse(
        openPrivate(this.key, this.context(row.id, row.owner, row.viewerWallet), row.ciphertext)
      )
    );
    if (contents.acceptance && contents.acceptance.expiresAt !== row.expiresAt.toISOString())
      throw new Error('OTC agreement expiry differs from the stored offer');
    return contents;
  }

  async create(owner: string, terms: OtcTerms, minutes: OtcExpiry, viewer: string | null) {
    if (viewer === owner) throw new SocialError('Use a different wallet for the counterparty.');
    const id = randomUUID();
    const token = randomBytes(32).toString('base64url');
    const ciphertext = sealPrivate(
      this.key,
      this.context(id, owner, viewer),
      JSON.stringify(terms)
    );
    const result = await this.db.query<{ expiresAt: Date }>(
      `WITH expired AS (
         DELETE FROM confidential_otc_offers WHERE id IN (
           SELECT id FROM confidential_otc_offers o WHERE expires_at<=now()
             AND NOT EXISTS(SELECT 1 FROM otc_rings_deals d WHERE d.offer_id=o.id)
           ORDER BY expires_at LIMIT 50
         )
       )
       INSERT INTO confidential_otc_offers(id,network_genesis,owner,viewer_wallet,token_hash,expires_at,ciphertext)
       VALUES($1,$2,$3,$4,$5,now()+$6::int*interval '1 minute',$7)
       RETURNING expires_at AS "expiresAt"`,
      [id, this.genesis, owner, viewer, hashToken(token), minutes, ciphertext]
    );
    const offer: OwnedOtcOffer = {
      id,
      viewerWallet: viewer,
      expiresAt: result.rows[0]!.expiresAt.toISOString(),
      terms,
      accepted: false,
    };
    return { token, offer };
  }

  async list(owner: string): Promise<OwnedOtcOffer[]> {
    const result = await this.db.query<OfferRow>(
      `SELECT ${projection},ciphertext FROM confidential_otc_offers
       WHERE network_genesis=$1 AND owner=$2 AND expires_at>now() ORDER BY expires_at DESC,id`,
      [this.genesis, owner]
    );
    return result.rows.map((row) => {
      const { terms, acceptance } = this.contents(row);
      return {
        id: row.id,
        viewerWallet: row.viewerWallet,
        expiresAt: row.expiresAt.toISOString(),
        terms,
        accepted: !!acceptance,
      };
    });
  }

  async revoke(owner: string, id: string) {
    try {
      const removed = await this.db.query(
        `DELETE FROM confidential_otc_offers o WHERE network_genesis=$1 AND owner=$2 AND id=$3
         AND NOT EXISTS(SELECT 1 FROM otc_rings_deals d WHERE d.offer_id=o.id) RETURNING id`,
        [this.genesis, owner, id]
      );
      if (!removed.rows.length) {
        const open = await this.db.query(
          'SELECT 1 FROM otc_rings_deals WHERE network_genesis=$1 AND maker=$2 AND offer_id=$3',
          [this.genesis, owner, id]
        );
        if (open.rows.length)
          throw new SocialError('This offer has an open settlement. Use its deal room.', 409);
      }
    } catch (error) {
      if (
        typeof error === 'object' &&
        error &&
        'code' in error &&
        ['23503', '23001'].includes(String(error.code))
      )
        throw new SocialError('This offer has an open settlement. Use its deal room.', 409);
      throw error;
    }
  }

  private async invitedOffer(token: string, wallet: string | null) {
    const row = (
      await this.db.query<OfferRow>(
        `SELECT ${projection},
         CASE WHEN viewer_wallet IS NULL OR viewer_wallet=$3 THEN ciphertext END AS ciphertext
         FROM confidential_otc_offers WHERE network_genesis=$1 AND token_hash=$2 AND expires_at>now()`,
        [this.genesis, hashToken(token), wallet]
      )
    ).rows[0];
    if (!row) throw new SocialError('This offer has expired, was revoked, or is invalid.', 404);
    if (!row.ciphertext)
      throw new SocialError('Sign in with the wallet invited to this offer.', 401);
    return row;
  }

  private viewFor(
    row: OfferRow,
    { terms, acceptance }: OfferContents,
    wallet: string | null
  ): ViewedOtcOffer {
    const status =
      acceptance !== null
        ? acceptance.wallet === wallet
          ? 'accepted'
          : 'reserved'
        : row.owner === wallet
          ? 'maker'
          : 'open';
    return {
      terms,
      ...(acceptance?.wallet === wallet && wallet ? { dealId: row.id } : {}),
      expiresAt: row.expiresAt.toISOString(),
      expiresInMs: row.expiresAt.getTime() - Date.now(),
      genesis: this.genesis,
      status,
      canAccept: status === 'open' && wallet !== null,
    };
  }

  async view(token: string, wallet: string | null) {
    const row = await this.invitedOffer(token, wallet);
    return this.viewFor(row, this.contents(row), wallet);
  }

  async acceptedDeal(id: string, wallet: string) {
    const result = await this.db.query<OfferRow>(
      `SELECT ${projection},ciphertext FROM confidential_otc_offers
       WHERE network_genesis=$1 AND id=$2 AND expires_at>now()`,
      [this.genesis, id]
    );
    const row = result.rows[0];
    if (!row) throw new SocialError('This OTC agreement is unavailable.', 404);
    const { terms, acceptance } = this.contents(row);
    if (!acceptance || (row.owner !== wallet && acceptance.wallet !== wallet))
      throw new SocialError('This OTC agreement is unavailable.', 404);
    return {
      maker: row.owner,
      taker: acceptance.wallet,
      terms,
      expiresAt: row.expiresAt.toISOString(),
    };
  }

  async accept(token: string, wallet: string, origin: string, signature: string) {
    const row = await this.invitedOffer(token, wallet);
    if (row.owner === wallet) throw new SocialError('You created this offer.');
    const existing = this.contents(row);
    const expiresAt = row.expiresAt.toISOString();
    const message = await otcAcceptanceMessage(token, wallet, origin, this.genesis, {
      terms: existing.terms,
      expiresAt,
    });
    if (!verifyWalletMessage(wallet, message, signature))
      throw new SocialError('Sign the exact offer terms with your wallet.', 403);
    if (existing.acceptance?.wallet === wallet) return this.viewFor(row, existing, wallet);
    if (existing.acceptance) throw new SocialError('This offer already has a counterparty.', 409);

    const contents = {
      terms: existing.terms,
      acceptance: { wallet, signature, expiresAt, origin },
    };
    const ciphertext = sealPrivate(
      this.key,
      this.context(row.id, row.owner, row.viewerWallet),
      JSON.stringify(contents)
    );
    const result = await this.db.query<{ id: string }>(
      `UPDATE confidential_otc_offers SET ciphertext=$4
       WHERE network_genesis=$1 AND id=$2 AND ciphertext=$3 AND expires_at>now()
       RETURNING id`,
      [this.genesis, row.id, row.ciphertext, ciphertext]
    );
    if (result.rows.length) return this.viewFor(row, contents, wallet);

    const latest = await this.view(token, wallet);
    if (latest.status === 'accepted') return latest;
    throw new SocialError('The offer changed. Refresh the terms before signing.', 409);
  }
}
