import type { GetServerSideProps } from 'next';
import { parseReferralCode } from '@/lib/whitelist';

/** Short referral link: mskd.fun/w/CODE -> /whitelist?ref=CODE */
export const getServerSideProps: GetServerSideProps = async ({ params }) => {
  const code = parseReferralCode(params?.code);
  return {
    redirect: { destination: code ? `/whitelist?ref=${code}` : '/whitelist', permanent: false },
  };
};

export default function ReferralRedirect(): null {
  return null;
}
