import { useState } from 'react';
import { toast } from 'sonner';
import { useWallet } from '@jup-ag/wallet-adapter';
import { Connection, Keypair, Transaction, sendAndConfirmRawTransaction } from '@solana/web3.js';

type SendTransactionOptions = {
  onSuccess?: (signature: string) => void;
  onError?: (error: string) => void;
  additionalSigners?: Keypair[];
};

export function useSendTransaction() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const { publicKey, signTransaction } = useWallet();

  const sendTransaction = async (
    transaction: Transaction,
    connection: Connection,
    options: SendTransactionOptions = {}
  ) => {
    if (!publicKey || !signTransaction) {
      const walletError = new Error('Wallet not connected');
      setError(walletError);
      toast.error('Wallet not connected. Please connect your wallet.');
      options.onError?.(walletError.message);
      return null;
    }

    setIsLoading(true);
    setError(null);
    setSignature(null);

    try {
      // Prepare transaction

      transaction.feePayer = transaction.feePayer || publicKey;
      if (!transaction.recentBlockhash) {
        const { blockhash } = await connection.getLatestBlockhash();
        transaction.recentBlockhash = blockhash;
      }

      // Simulate transaction
      const simulation = await connection.simulateTransaction(transaction);

      if (simulation.value.err) {
        throw new Error(`Transaction simulation failed: ${JSON.stringify(simulation.value.err)}`);
      }

      // Add every non-wallet signature first; sign() would discard existing signatures.
      if (options.additionalSigners?.length) transaction.partialSign(...options.additionalSigners);
      const signedTransaction = await signTransaction(transaction);

      const txSignature = await sendAndConfirmRawTransaction(
        connection,
        signedTransaction.serialize(),
        { commitment: 'confirmed' }
      );

      setSignature(txSignature);
      options.onSuccess?.(txSignature);
      return txSignature;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      setError(new Error(errorMessage));
      options.onError?.(`Transaction failed: ${errorMessage}`);
      return null;
    } finally {
      setIsLoading(false);
    }
  };

  return {
    sendTransaction,
    isLoading,
    error,
    signature,
  };
}
