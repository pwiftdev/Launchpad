import Page from '@/components/ui/Page/Page';
import { Board } from '@/components/board/Board';
import { useCoins } from '@/hooks/useCoins';
export { requireAdminPage as getServerSideProps } from '@/server/adminPage';

export default function Index() {
  const { data: coins, status, displayStale } = useCoins();

  return (
    <Page app>
      <Board coins={coins} status={status} displayStale={displayStale} />
    </Page>
  );
}
