import { BondHero } from '@/components/board/BondHero';
import { useCoins } from '@/hooks/useCoins';

/** Keep the alternate home entry on the same current policy as the trading board. */
export const Hero = () => {
  const { data } = useCoins();
  return <BondHero coins={data} />;
};
