import { describe, expect, it, vi } from 'vitest';
import { requireSafeRetry } from './otcRingsRetry';

const lifetime = { blockhash: 'fixture', lastValidBlockHeight: '100' };
const sig = 'fixture-signature';
const result = (confirmationStatus: 'confirmed' | 'finalized', err: object | null = null) => ({
  value: { confirmationStatus, err },
});

function rpc() {
  return {
    getSignatureStatus: vi.fn().mockResolvedValue({ value: null }),
    getBlockHeight: vi.fn().mockResolvedValue(101),
    isBlockhashValid: vi.fn().mockResolvedValue({ value: false }),
  };
}

describe('OTC retry after restart or a lost RPC response', () => {
  it.each([result('confirmed'), result('finalized'), result('confirmed', {})])(
    'keeps transactions that are live or succeeded',
    async (status) => {
      const connection = rpc();
      connection.getSignatureStatus.mockResolvedValue(status);
      await expect(requireSafeRetry(connection, lifetime, sig)).rejects.toHaveProperty(
        'status',
        409
      );
    }
  );

  it('checks again after observing expiration so a late acknowledgement cannot enable another funding', async () => {
    const connection = rpc();
    connection.getSignatureStatus
      .mockResolvedValueOnce({ value: null })
      .mockResolvedValueOnce(result('finalized'));
    await expect(requireSafeRetry(connection, lifetime, sig)).rejects.toHaveProperty('status', 409);
    expect(connection.getSignatureStatus).toHaveBeenCalledTimes(2);
  });

  it('refuses an ambiguous status or a hash still accepted by a confirmed node', async () => {
    const connection = rpc();
    connection.getSignatureStatus.mockRejectedValueOnce(new Error('RPC unavailable'));
    await expect(requireSafeRetry(connection, lifetime, sig)).rejects.toThrow('RPC unavailable');
    connection.isBlockhashValid.mockResolvedValueOnce({ value: true });
    await expect(requireSafeRetry(connection, lifetime, sig)).rejects.toHaveProperty('status', 409);
  });

  it('permits finalized failures and packets missing beyond their blockhash lifetime', async () => {
    const connection = rpc();
    connection.getSignatureStatus.mockResolvedValueOnce(result('finalized', {}));
    await expect(requireSafeRetry(connection, lifetime, sig)).resolves.toBeUndefined();
    await expect(requireSafeRetry(connection, lifetime, sig)).resolves.toBeUndefined();
  });
});
