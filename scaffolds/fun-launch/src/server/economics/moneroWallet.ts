// A small client for monero-wallet-rpc: balance, signed-but-unrelayed transfers, relay, and
// confirmations. The payout wallet runs next to the operator; the node it uses is configurable
// (a remote node for now, our own later).
import { createHash, randomBytes } from 'node:crypto';

export type MoneroDestination = { address: string; amount: bigint };
export type SignedTransfers = {
  txHashes: string[];
  txMetadata: string[];
  amounts: bigint[];
  fees: bigint[];
};

const md5 = (value: string) => createHash('md5').update(value).digest('hex');

/** HTTP digest authentication (RFC 7616, MD5, qop=auth), as monero-wallet-rpc --rpc-login uses. */
export function digestHeader(
  challenge: string,
  args: { username: string; password: string; method: string; uri: string; cnonce?: string }
) {
  const field = (name: string) => challenge.match(new RegExp(`${name}="?([^",]+)"?`, 'i'))?.[1];
  const realm = field('realm'),
    nonce = field('nonce'),
    qop = field('qop')
      ?.split(/\s*,\s*/)
      .includes('auth')
      ? 'auth'
      : undefined,
    algorithm = field('algorithm') ?? 'MD5';
  if (!realm || !nonce || algorithm.toUpperCase() !== 'MD5')
    throw new Error('Unsupported Monero wallet authentication');
  const cnonce = args.cnonce ?? randomBytes(8).toString('hex'),
    nc = '00000001';
  const ha1 = md5(`${args.username}:${realm}:${args.password}`),
    ha2 = md5(`${args.method}:${args.uri}`);
  const response = qop
    ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${nonce}:${ha2}`);
  return [
    `Digest username="${args.username}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${args.uri}"`,
    `algorithm=MD5`,
    `response="${response}"`,
    ...(qop ? [`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`] : []),
  ].join(', ');
}

export class MoneroWalletError extends Error {}

export class MoneroWallet {
  private readonly url: URL;
  private readonly login?: { username: string; password: string };
  constructor(
    url: string,
    login?: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly timeoutMs = 30_000
  ) {
    this.url = new URL('/json_rpc', url);
    if (login) {
      const at = login.indexOf(':');
      if (at < 1) throw new Error('MONERO_WALLET_RPC_LOGIN must be user:password');
      this.login = { username: login.slice(0, at), password: login.slice(at + 1) };
    }
  }

  private async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const body = JSON.stringify({ jsonrpc: '2.0', id: '0', method, params });
    const send = (authorization?: string) =>
      this.fetcher(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authorization ? { Authorization: authorization } : {}),
        },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    let response = await send();
    if (response.status === 401 && this.login) {
      const challenge = response.headers.get('www-authenticate') ?? '';
      response = await send(
        digestHeader(challenge, { ...this.login, method: 'POST', uri: this.url.pathname })
      );
    }
    if (!response.ok) throw new MoneroWalletError(`Monero wallet HTTP ${response.status}`);
    const json = (await response.json()) as { result?: T; error?: { message?: string } };
    if (json.error || json.result === undefined)
      throw new MoneroWalletError(`Monero wallet: ${json.error?.message ?? 'empty result'}`);
    return json.result;
  }

  async height() {
    return (await this.call<{ height: number }>('get_height')).height;
  }

  /** Account 0: everything, and what can be spent now. Piconero. */
  async balance() {
    const result = await this.call<{ balance: number | string; unlocked_balance: number | string }>(
      'get_balance',
      { account_index: 0 }
    );
    return { balance: BigInt(result.balance), unlocked: BigInt(result.unlocked_balance) };
  }

  async validAddress(address: string) {
    return (await this.call<{ valid: boolean }>('validate_address', { address })).valid;
  }

  /** Builds and signs the transfers without broadcasting them. */
  async signTransfers(destinations: MoneroDestination[]): Promise<SignedTransfers> {
    const result = await this.call<{
      tx_hash_list: string[];
      tx_metadata_list: string[];
      amount_list: (number | string)[];
      fee_list: (number | string)[];
    }>('transfer_split', {
      destinations: destinations.map((d) => {
        if (d.amount <= 0n || d.amount > BigInt(Number.MAX_SAFE_INTEGER))
          throw new MoneroWalletError('Payout amount is outside the wallet RPC range');
        return { address: d.address, amount: Number(d.amount) };
      }),
      account_index: 0,
      priority: 0,
      do_not_relay: true,
      get_tx_metadata: true,
    });
    if (
      !result.tx_hash_list?.length ||
      result.tx_metadata_list?.length !== result.tx_hash_list.length
    )
      throw new MoneroWalletError('Monero wallet returned no signed transactions');
    return {
      txHashes: result.tx_hash_list,
      txMetadata: result.tx_metadata_list,
      amounts: result.amount_list.map((value) => BigInt(value)),
      fees: result.fee_list.map((value) => BigInt(value)),
    };
  }

  /** Broadcasts one signed transaction. Relaying the same one again is harmless. */
  async relay(txMetadata: string) {
    return (await this.call<{ tx_hash: string }>('relay_tx', { hex: txMetadata })).tx_hash;
  }

  /** Confirmations for one of our outgoing transactions; null when the wallet does not know it. */
  async confirmations(txHash: string): Promise<{ confirmations: number; failed: boolean } | null> {
    try {
      const result = await this.call<{
        transfer?: { confirmations?: number; type?: string };
      }>('get_transfer_by_txid', { txid: txHash });
      const transfer = result.transfer;
      if (!transfer) return null;
      return {
        confirmations: transfer.confirmations ?? 0,
        failed: transfer.type === 'failed',
      };
    } catch (error) {
      if (
        error instanceof MoneroWalletError &&
        /not found|Transaction not found/i.test(error.message)
      )
        return null;
      throw error;
    }
  }

  /** The treasury's primary address (account 0, index 0). */
  async address() {
    return (await this.call<{ address: string }>('get_address', { account_index: 0 })).address;
  }

  /** The private view key. It reveals incoming funds only and cannot spend. */
  async viewKey() {
    return (await this.call<{ key: string }>('query_key', { key_type: 'view_key' })).key;
  }

  /** Signed key images for every output, so a view-only wallet can see what was spent. */
  async exportKeyImages() {
    const result = await this.call<{
      offset?: number;
      signed_key_images?: { key_image: string; signature: string }[];
    }>('export_key_images', { all: true });
    return { offset: result.offset ?? 0, signedKeyImages: result.signed_key_images ?? [] };
  }

  /** Confirmed incoming transfers from this height on. Piconero. */
  async incoming(minHeight: number) {
    const result = await this.call<{
      in?: { txid: string; amount: number | string; height: number; timestamp: number }[];
    }>('get_transfers', {
      in: true,
      account_index: 0,
      filter_by_height: true,
      min_height: Math.max(0, minHeight - 1),
    });
    return (result.in ?? []).map((row) => ({
      txid: row.txid,
      amount: BigInt(row.amount),
      height: row.height,
      receivedAt: new Date(row.timestamp * 1000),
    }));
  }

  /** The key that lets a recipient prove they received a payment. */
  async txKey(txHash: string) {
    return (await this.call<{ tx_key: string }>('get_tx_key', { txid: txHash })).tx_key;
  }
}

export function moneroWalletFromEnv(env = process.env) {
  if (!env.MONERO_WALLET_RPC_URL) return null;
  return new MoneroWallet(env.MONERO_WALLET_RPC_URL, env.MONERO_WALLET_RPC_LOGIN);
}
