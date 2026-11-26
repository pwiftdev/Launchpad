import { PublicKey, type AccountInfo, type Connection } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { QUOTES } from '@/lib/feeModes';

const POOL = new PublicKey('3wK2g8ZdzAH8FJ7PKr2RcvGh7V9VYson5hrVsJM5Lmws');
const PROGRAM = new PublicKey('SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY');
const MINT = new PublicKey(QUOTES.hsol.mint);
const POOL_MINT_OFFSET = 162;
const TOKEN_PROGRAM_OFFSET = 226;
const TOTAL_LAMPORTS_OFFSET = 258;
const SHARE_SUPPLY_OFFSET = 266;

export function readHsolRate(account: AccountInfo<Buffer> | null) {
  if (
    !account ||
    account.executable ||
    !account.owner.equals(PROGRAM) ||
    account.data.length < SHARE_SUPPLY_OFFSET + 8 ||
    account.data[0] !== 1 ||
    !account.data.subarray(POOL_MINT_OFFSET, POOL_MINT_OFFSET + 32).equals(MINT.toBuffer()) ||
    !account.data
      .subarray(TOKEN_PROGRAM_OFFSET, TOKEN_PROGRAM_OFFSET + 32)
      .equals(TOKEN_PROGRAM_ID.toBuffer())
  )
    throw new Error('Invalid hSOL stake pool');
  const backing = account.data.readBigUInt64LE(TOTAL_LAMPORTS_OFFSET);
  const supply = account.data.readBigUInt64LE(SHARE_SUPPLY_OFFSET);
  if (backing === 0n || supply === 0n) throw new Error('hSOL conversion unavailable');
  return Number(backing) / Number(supply);
}

export function createHsolRateReader(connection: Pick<Connection, 'getAccountInfo'>) {
  let cached: { at: number; rate: number } | undefined;
  let pending: Promise<number> | undefined;
  return async function hsolRate() {
    if (cached && Date.now() - cached.at < 60_000) return cached.rate;
    pending ??= connection
      .getAccountInfo(POOL, 'finalized')
      .then((account) => {
        const rate = readHsolRate(account);
        cached = { at: Date.now(), rate };
        return rate;
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
}
