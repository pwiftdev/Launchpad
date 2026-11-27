// Publishes what anyone needs to audit the Monero treasury: its address and private view key
// (incoming funds), signed key images (what was spent), and the XMR it received. Runs in the
// payout operator beside monero-wallet-rpc. Nothing published here can move funds.
import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { database } from '../database';
import { viewKeyMatchesAddress, type MoneroNetwork } from '@/lib/monero';
import type { MoneroWallet } from './moneroWallet';

type Db = Pick<Pool, 'query'>;
type TreasuryWallet = Pick<MoneroWallet, 'address' | 'viewKey' | 'exportKeyImages' | 'incoming'>;

export class MaskedTreasuryProof {
  constructor(
    private readonly wallet: TreasuryWallet,
    private readonly network: string,
    private readonly moneroNetwork: MoneroNetwork,
    private readonly options: { db?: Db; restoreHeight?: number } = {}
  ) {}
  private get db() {
    return this.options.db ?? database();
  }

  async publish(height: number) {
    const [address, viewKey] = await Promise.all([this.wallet.address(), this.wallet.viewKey()]);
    // Never publish a key that a view-only wallet would reject for this address.
    if (!viewKeyMatchesAddress(address, viewKey, this.moneroNetwork))
      throw new Error('The treasury view key does not match its address');
    await this.db.query(
      `INSERT INTO masked_treasury_keys(network_genesis,primary_address,view_key,restore_height,published_at)
       VALUES($1,$2,$3,$4,now()) ON CONFLICT(network_genesis) DO UPDATE SET primary_address=EXCLUDED.primary_address,
       view_key=EXCLUDED.view_key,restore_height=EXCLUDED.restore_height,published_at=now()
       WHERE (masked_treasury_keys.primary_address,masked_treasury_keys.view_key,masked_treasury_keys.restore_height)
         IS DISTINCT FROM (EXCLUDED.primary_address,EXCLUDED.view_key,EXCLUDED.restore_height)`,
      [this.network, address, viewKey, this.options.restoreHeight ?? null]
    );

    const since = (
      await this.db.query<{ height: string | null }>(
        'SELECT max(height)::text AS height FROM masked_xmr_inflows WHERE network_genesis=$1',
        [this.network]
      )
    ).rows[0]?.height;
    const inflows = await this.wallet.incoming(
      since ? Number(since) : (this.options.restoreHeight ?? 0)
    );
    let received = 0;
    for (const row of inflows) {
      if (!/^[a-f0-9]{64}$/.test(row.txid) || row.amount <= 0n) continue;
      const inserted = await this.db.query(
        `INSERT INTO masked_xmr_inflows(network_genesis,txid,amount_atomic,height,received_at)
         VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [this.network, row.txid, row.amount.toString(), row.height, row.receivedAt]
      );
      received += inserted.rowCount ?? 0;
    }

    const images = await this.wallet.exportKeyImages();
    const payload = images.signedKeyImages.map(({ key_image, signature }) => ({
      key_image,
      signature,
    }));
    const digest = createHash('sha256')
      .update(JSON.stringify({ offset: images.offset, payload }))
      .digest('hex');
    const exported = await this.db.query(
      `INSERT INTO masked_key_image_exports(id,network_genesis,wallet_height,key_image_count,export_offset,payload,digest)
       VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(network_genesis,digest) DO NOTHING`,
      [
        randomUUID(),
        this.network,
        height,
        payload.length,
        images.offset,
        JSON.stringify(payload),
        digest,
      ]
    );
    return { address, received, keyImages: payload.length, newExport: !!exported.rowCount };
  }
}
