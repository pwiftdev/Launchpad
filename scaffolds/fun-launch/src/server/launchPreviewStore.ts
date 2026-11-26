import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { LAUNCH_IMAGE_MAX_MB } from '@/constants/launch';
import { FEE_MODE_IDS } from '@/lib/feeModes';
import { normalizeSocials } from '@/lib/socials';
import type { LaunchPreviewDraft, PreviewInvite, SavedPreview } from '@/lib/launchPreview';
import { database } from './database';
import { decodeDataUrl, normalizeLaunchImage } from './launchImage';
import { derivePrivateKey, openPrivate, sealPrivate } from './privateEncryption';
import { SocialError } from './profileStore';
import { launchMetadataSchema } from './validation';

export const launchPreviewDraft = launchMetadataSchema
  .extend({ mode: z.enum(FEE_MODE_IDS) })
  .strict();

const revisionConflict = () =>
  new SocialError('The saved draft changed. Refresh it and try again.', 409);
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
type DraftRow = { ciphertext?: Buffer; revision: number };
type InviteRow = Omit<PreviewInvite, 'id' | 'expiresAt'> & {
  expiresAt: Date;
  owner: string;
  revision: number;
  ciphertext?: Buffer | null;
};

function draftCipher(secret: Buffer, genesis: string, owner: string, revision: number) {
  const key = derivePrivateKey(secret, 'mskd-launch-preview/v1/draft');
  const context = JSON.stringify([genesis, owner, revision]);
  return {
    encrypt: (draft: LaunchPreviewDraft) => sealPrivate(key, context, JSON.stringify(draft)),
    decrypt: (ciphertext: Buffer) =>
      launchPreviewDraft.parse(JSON.parse(openPrivate(key, context, ciphertext))),
  };
}

let activeImages = 0;
async function previewImage(data: string) {
  if (activeImages >= 2) throw new SocialError('Artwork is busy. Try saving again shortly.', 429);
  activeImages++;
  try {
    const image = await normalizeLaunchImage(decodeDataUrl(data));
    return `data:${image.contentType};base64,${image.buffer.toString('base64')}`;
  } catch {
    throw new SocialError(`Use a PNG, JPEG, GIF or WebP image up to ${LAUNCH_IMAGE_MAX_MB} MB.`);
  } finally {
    activeImages--;
  }
}

export class LaunchPreviewStore {
  constructor(
    private readonly secret: Buffer,
    private readonly genesis: string,
    private readonly db: Pick<Pool, 'query'> = database()
  ) {}

  async load(owner: string, includeDraft: boolean): Promise<SavedPreview> {
    const row = (
      await this.db.query<DraftRow & { invites: PreviewInvite[] }>(
        `SELECT d.revision${includeDraft ? ',d.ciphertext' : ''},COALESCE((
          SELECT json_agg(json_build_object('id',i.id,'expiresAt',i.expires_at,'viewerWallet',i.viewer_wallet)
            ORDER BY i.expires_at DESC,i.id)
          FROM launch_preview_invites i
          WHERE i.network_genesis=d.network_genesis AND i.owner=d.owner AND i.revision=d.revision AND i.expires_at>now()
        ),'[]'::json) AS invites
        FROM launch_preview_drafts d WHERE d.network_genesis=$1 AND d.owner=$2`,
        [this.genesis, owner]
      )
    ).rows[0];
    if (!row) return { draft: null, revision: 0, invites: [] };
    return {
      draft: row.ciphertext
        ? draftCipher(this.secret, this.genesis, owner, row.revision).decrypt(row.ciphertext)
        : null,
      revision: row.revision,
      invites: row.invites.map((invite) => ({
        ...invite,
        expiresAt: new Date(invite.expiresAt).toISOString(),
      })),
    };
  }

  async save(owner: string, expectedRevision: number, draft: LaunchPreviewDraft) {
    const normalized = {
      ...draft,
      tokenLogo: await previewImage(draft.tokenLogo),
      sourceUrl: draft.sourceUrl?.trim(),
      socials: normalizeSocials(draft.socials),
    };
    const revision = expectedRevision + 1;
    const ciphertext = draftCipher(this.secret, this.genesis, owner, revision).encrypt(normalized);
    const result = await (expectedRevision === 0
      ? this.db.query(
          `INSERT INTO launch_preview_drafts(network_genesis,owner,revision,ciphertext)
           VALUES($1,$2,1,$3) ON CONFLICT(network_genesis,owner) DO NOTHING`,
          [this.genesis, owner, ciphertext]
        )
      : this.db.query(
          `UPDATE launch_preview_drafts SET revision=revision+1,ciphertext=$3
           WHERE network_genesis=$1 AND owner=$2 AND revision=$4`,
          [this.genesis, owner, ciphertext, expectedRevision]
        ));
    if (!result.rowCount) throw revisionConflict();
    return { revision };
  }

  async invite(owner: string, revision: number, hours: number, viewerWallet: string | null) {
    const token = randomBytes(32).toString('base64url');
    const id = randomUUID();
    const inserted = await this.db.query<{ expiresAt: Date }>(
      `WITH expired AS (
        DELETE FROM launch_preview_invites WHERE id IN(
          SELECT id FROM launch_preview_invites WHERE expires_at<=now() ORDER BY expires_at LIMIT 100
        )
      )
      INSERT INTO launch_preview_invites(id,network_genesis,owner,revision,token_hash,viewer_wallet,expires_at)
      SELECT $1,network_genesis,owner,revision,$2,$3,now()+$4::int*interval '1 hour'
      FROM launch_preview_drafts WHERE network_genesis=$5 AND owner=$6 AND revision=$7
      RETURNING expires_at AS "expiresAt"`,
      [id, tokenHash(token), viewerWallet, hours, this.genesis, owner, revision]
    );
    const row = inserted.rows[0];
    if (!row) throw revisionConflict();
    return { token, invite: { id, viewerWallet, expiresAt: row.expiresAt.toISOString() } };
  }

  async revoke(owner: string, id: string) {
    await this.db.query(
      'DELETE FROM launch_preview_invites WHERE network_genesis=$1 AND owner=$2 AND id=$3',
      [this.genesis, owner, id]
    );
  }

  async view(token: string, wallet: string | null, includeDraft: boolean) {
    const row = (
      await this.db.query<InviteRow>(
        `SELECT i.viewer_wallet AS "viewerWallet",i.expires_at AS "expiresAt",d.owner,d.revision
          ${includeDraft ? ',CASE WHEN i.viewer_wallet IS NULL OR i.viewer_wallet=$3 THEN d.ciphertext END AS ciphertext' : ''}
         FROM launch_preview_invites i
         JOIN launch_preview_drafts d USING(network_genesis,owner,revision)
         WHERE i.network_genesis=$1 AND i.token_hash=$2 AND i.expires_at>now()`,
        includeDraft ? [this.genesis, tokenHash(token), wallet] : [this.genesis, tokenHash(token)]
      )
    ).rows[0];
    if (!row) throw new SocialError('This invite has expired, was revoked, or is invalid.', 404);
    if (row.viewerWallet && row.viewerWallet !== wallet)
      throw new SocialError('Sign in with the wallet invited to this preview.', 401);
    return {
      expiresAt: row.expiresAt.toISOString(),
      expiresInMs: row.expiresAt.getTime() - Date.now(),
      ...(row.ciphertext
        ? {
            draft: draftCipher(this.secret, this.genesis, row.owner, row.revision).decrypt(
              row.ciphertext
            ),
          }
        : {}),
    };
  }
}
