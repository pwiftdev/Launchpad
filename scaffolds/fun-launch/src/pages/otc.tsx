import { useEffect, useState } from 'react';
import Head from 'next/head';
import dynamic from 'next/dynamic';
import type { GetServerSideProps } from 'next';
import { useRouter } from 'next/router';
import { useUnifiedWalletContext, useWallet } from '@jup-ag/wallet-adapter';
import { Button } from '@/components/ui/button';
import { OtcDesk } from '@/components/otc/OtcDesk';
import { OtcExplainer } from '@/components/otc/OtcExplainer';
import { OtcFlow, OtcHero, type OtcFlowStep } from '@/components/otc/OtcHero';
import {
  isOtcSectionHash,
  OtcGrid,
  OtcIcon,
  OtcPanelHead,
  OtcPrivacy,
  otcFeature,
} from '@/components/otc/OtcLayout';
import { OtcOfferReview } from '@/components/otc/OtcOfferReview';
import Page from '@/components/ui/Page/Page';
import { OTC_PATH } from '@/constants/nav';
import { readOtcInvite } from '@/lib/otc';
import { cn } from '@/lib/utils';
import { adminPageRedirect } from '@/server/adminPage';
import { otcConfig } from '@/server/otcConfig';
import { otcRingsConfig } from '@/server/otcRingsConfig';

const OtcRingsDeal = dynamic(() => import('@/components/otc/OtcRingsDeal'), {
  ssr: false,
  loading: () => (
    <p role="status" className="eyebrow py-6">
      Opening deal…
    </p>
  ),
});
type Props = { mode: 'mainnet' | 'test' | null; settlement?: 'enabled' | 'recovery' };

export const getServerSideProps: GetServerSideProps<Props> = async (context) => {
  const redirect = adminPageRedirect(context);
  context.res.setHeader('Referrer-Policy', 'no-referrer');
  context.res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  const rings = otcRingsConfig();
  return (
    redirect ?? {
      props: {
        mode: otcConfig()?.mode ?? null,
        ...(rings ? { settlement: rings.enabled ? 'enabled' : 'recovery' } : {}),
      },
    }
  );
};

export default function OtcPage({ mode, settlement }: Props) {
  const router = useRouter();
  const { publicKey } = useWallet();
  const { setShowModal } = useUnifiedWalletContext();
  const wallet = publicKey?.toBase58();
  const [invite, setInvite] = useState<{ token: string; hasLink: boolean }>();
  const [deal, setDeal] = useState<string>();
  const live = settlement === 'enabled';
  const openDeal = (id: string) => {
    setDeal(id);
    window.history.replaceState(window.history.state, '', `${OTC_PATH}?deal=${id}`);
  };
  const back = () => {
    setDeal(undefined);
    window.history.replaceState(window.history.state, '', window.location.pathname);
    setInvite({ token: '', hasLink: false });
  };

  useEffect(() => {
    if (!mode) return;
    const read = () => {
      const id = new URLSearchParams(window.location.search).get('deal');
      setDeal(settlement && id && /^[a-f0-9-]{36}$/.test(id) ? id : undefined);
      const hasLink = !!window.location.hash && !isOtcSectionHash(window.location.hash);
      setInvite({ hasLink, token: readOtcInvite() });
    };
    read();
    window.addEventListener('hashchange', read);
    router.events.on('hashChangeComplete', read);
    return () => {
      window.removeEventListener('hashchange', read);
      router.events.off('hashChangeComplete', read);
    };
  }, [mode, settlement, router.events]);

  const [deskStep, setDeskStep] = useState<OtcFlowStep>('create');
  const flowStep: OtcFlowStep = invite?.token || invite?.hasLink ? 'agree' : deskStep;
  return (
    <Page containerClassName="max-w-6xl pb-24 md:pb-16">
      <Head>
        <title>Confidential OTC | MSKD.fun</title>
        <meta name="robots" content="noindex, nofollow, noarchive" />
        <meta name="referrer" content="no-referrer" />
      </Head>
      <OtcHero mode={mode} settlement={settlement} />
      {mode && !deal && <OtcFlow settlement={settlement} active={flowStep} />}
      {mode && !live && (
        <p
          role="note"
          className="mb-4 flex items-start gap-2.5 border border-neutral-800 bg-neutral-950 px-4 py-3 text-sm text-neutral-300"
        >
          <OtcIcon
            name={settlement === 'recovery' ? 'ph--pause-circle' : 'ph--info'}
            className="mt-px h-4 w-4 text-amber"
          />
          {settlement === 'recovery'
            ? 'New settlements are paused. You can still open existing deals and recover eligible funds.'
            : 'Offers and agreements are off-chain. Settlement is unavailable on this deployment.'}
        </p>
      )}
      <div id="otc-desk" tabIndex={-1} className="scroll-mt-6">
        {!mode ? (
          <section className={cn(otcFeature, 'p-6 sm:p-8')}>
            <OtcPanelHead eyebrow="Desk closed" title="OTC is unavailable here" icon="ph--lock">
              This deployment isn’t taking OTC offers right now. The walkthrough below explains how
              the desk works when it’s open.
            </OtcPanelHead>
          </section>
        ) : deal && settlement ? (
          wallet ? (
            <OtcRingsDeal
              key={`${deal}:${wallet}`}
              id={deal}
              wallet={wallet}
              onBack={back}
              enabled={live}
            />
          ) : (
            <OtcGrid aside={<OtcPrivacy settlement />}>
              <section className={cn(otcFeature, 'space-y-5 p-5 sm:p-8')}>
                <OtcPanelHead eyebrow="Deal in progress" title="Resume your deal" icon="ph--wallet">
                  Connect one of the two wallets that agreed to this deal to see where it stands.
                </OtcPanelHead>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" size="lg" variant="holo" onClick={() => setShowModal(true)}>
                    <OtcIcon name="ph--wallet" className="h-4 w-4" /> Connect wallet
                  </Button>
                  <Button type="button" size="lg" variant="ghost" onClick={back}>
                    Back to desk
                  </Button>
                </div>
              </section>
            </OtcGrid>
          )
        ) : !invite ? (
          <p role="status" className="eyebrow py-6">
            Opening OTC…
          </p>
        ) : invite.token || invite.hasLink ? (
          <OtcGrid aside={<OtcPrivacy settlement={!!settlement} />}>
            {invite.token ? (
              <OtcOfferReview
                key={`${invite.token}:${wallet ?? ''}`}
                token={invite.token}
                wallet={wallet}
                onDeal={live ? openDeal : undefined}
                onBack={back}
              />
            ) : (
              <section className={cn(otcFeature, 'space-y-5 p-5 sm:p-8')}>
                <OtcPanelHead eyebrow="Private offer" title="Link incomplete" icon="ph--link-break">
                  Open the original offer link, exactly as it was sent, to review its terms.
                </OtcPanelHead>
                <Button type="button" variant="outline" onClick={back}>
                  Back to desk
                </Button>
              </section>
            )}
          </OtcGrid>
        ) : (
          <OtcDesk
            key={wallet ?? 'disconnected'}
            wallet={wallet}
            onDeal={settlement ? openDeal : undefined}
            settlementEnabled={live}
            onStep={setDeskStep}
          />
        )}
      </div>
      <OtcExplainer settlement={mode ? settlement : undefined} />
    </Page>
  );
}
