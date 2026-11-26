import { OFFICIAL_MSKD } from '@/constants/officialMskd';

export { OFFICIAL_MSKD };

export const OFFICIAL_MSKD_RESERVED = 'Masked and MSKD are reserved for the official launch.';
const reservedLabels = new Set(['masked', 'mskd', 'maskedmskd', 'mskdmasked']);

function reservedLabel(value: string): boolean {
  const label = value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[аα]/gu, 'a')
    .replaceAll('ԁ', 'd')
    .replace(/[еεϵ]/gu, 'e')
    .replace(/[кκᴋ]/gu, 'k')
    .replace(/[мμᴍ]/gu, 'm')
    .replace(/[ѕꜱ]/gu, 's')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .replaceAll('rn', 'm');
  return reservedLabels.has(label);
}

export function allowsMskdIdentity(input: {
  name: string;
  symbol: string;
  mint: string;
  deployer?: string;
}): boolean {
  const { name, symbol, mint, deployer } = input;
  if (mint === OFFICIAL_MSKD.mint)
    return (
      deployer === OFFICIAL_MSKD.deployer &&
      name === OFFICIAL_MSKD.name &&
      symbol === OFFICIAL_MSKD.symbol
    );
  return !reservedLabel(name) && !reservedLabel(symbol);
}

export function assertMskdCreationIdentity(data: object, mint: string, deployer: string) {
  const params = (data as { params?: { name?: unknown; symbol?: unknown } }).params;
  if (typeof params?.name !== 'string' || typeof params.symbol !== 'string')
    throw new Error('Invalid launch identity');
  if (!allowsMskdIdentity({ name: params.name, symbol: params.symbol, mint, deployer }))
    throw new Error(OFFICIAL_MSKD_RESERVED);
}
