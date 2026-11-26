import { describe, expect, it } from 'vitest';
import { allowsMskdIdentity, OFFICIAL_MSKD } from './officialMskd';

const ordinary = {
  name: 'Masked Frog',
  symbol: 'MASK',
  mint: 'ofZurUDfxyue9wHftHF5yGWXY8oHkyoAWa3w5JQZtst',
  deployer: 'FiFmAXm5cTx1sCH5zSUpBbDFt9rVgCfuGhMVahDWLmHm',
};

describe('official Masked launch identity', () => {
  it.each([
    { name: 'Masked', symbol: 'OTHER' },
    { name: 'Other project', symbol: 'MSKD' },
    { name: 'Ｍａｓｋｅｄ', symbol: 'OTHER' },
    { name: 'Other project', symbol: '$M.S\u200bK.D' },
    { name: 'Mаskеd', symbol: 'OTHER' },
    { name: 'Other project', symbol: 'МЅКԁ' },
    { name: 'Masked ($MSKD)', symbol: 'OTHER' },
  ])('reserves $name / $symbol for the official launch', (labels) => {
    expect(allowsMskdIdentity({ ...ordinary, ...labels })).toBe(false);
    expect(allowsMskdIdentity({ ...ordinary, ...labels, deployer: OFFICIAL_MSKD.deployer })).toBe(
      false
    );
  });

  it('requires the exact approved wallet, mint, name and ticker for the official token', () => {
    expect(allowsMskdIdentity(OFFICIAL_MSKD)).toBe(true);
    expect(allowsMskdIdentity({ ...OFFICIAL_MSKD, deployer: ordinary.deployer })).toBe(false);
    expect(allowsMskdIdentity({ ...OFFICIAL_MSKD, deployer: undefined })).toBe(false);
    expect(allowsMskdIdentity({ ...OFFICIAL_MSKD, mint: ordinary.mint })).toBe(false);
    expect(
      allowsMskdIdentity({ ...OFFICIAL_MSKD, name: ordinary.name, symbol: ordinary.symbol })
    ).toBe(false);
    expect(allowsMskdIdentity({ ...OFFICIAL_MSKD, symbol: 'mskd' })).toBe(false);
  });

  it('allows unrelated labels and forbids reusing the official mint with unrelated labels', () => {
    expect(allowsMskdIdentity(ordinary)).toBe(true);
    expect(allowsMskdIdentity({ ...ordinary, mint: OFFICIAL_MSKD.mint })).toBe(false);
  });
});
