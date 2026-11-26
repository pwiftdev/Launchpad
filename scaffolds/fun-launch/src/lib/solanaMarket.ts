export type SolanaMarket = {
  hourlyCloses: { value: number[]; stale: boolean } | null;
};
