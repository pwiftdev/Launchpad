export type LaunchPreparationContext = {
  genesis: string;
  preparedSlot: number;
  lastValidBlockHeight: number;
  blockhash: string;
  messageDigest: string;
  messageBase64: string;
  preparationProof: string;
};
