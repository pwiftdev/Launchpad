import '@/styles/globals.css';
import '@/styles/wallet.css';
import { Adapter, UnifiedWalletProvider } from '@jup-ag/wallet-adapter';
import NextApp, { type AppContext, type AppProps } from 'next/app';
import { ThemeProvider, useTheme } from 'next-themes';
import { Toaster } from 'sonner';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom';
import { SolflareWalletAdapter } from '@solana/wallet-adapter-solflare';
import { useMemo } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useWindowWidthListener } from '@/lib/device';
import { Geist, Geist_Mono, Silkscreen } from 'next/font/google';
import Head from 'next/head';
import { BRAND } from '@/constants/brand';
import { WALLET_NETWORK } from '@/constants/network';
import { Splash } from '@/components/brand/Splash';
import { GrainField } from '@/components/brand/GrainField';
import { WalletModalBranding } from '@/components/brand/WalletModalBranding';
import { ThesisModal } from '@/components/brand/ThesisModal';

const fontSans = Geist({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });
// Pixel face: headlines, labels, buttons and big numbers. Body copy stays in the sans.
const fontPixel = Silkscreen({
  subsets: ['latin'],
  weight: ['400', '700'],
  variable: '--font-pixel',
  display: 'swap',
});
// True monospace for code, addresses and the ASCII renderer's character grid
const fontTerm = Geist_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-term',
  display: 'swap',
});

// Defined on :root so portals (wallet modal, toasts) get the brand fonts too
const fontRootStyle = `:root {
  --font-sans: ${fontSans.style.fontFamily};
  --font-display: ${fontPixel.style.fontFamily};
  --font-term: ${fontPixel.style.fontFamily};
  --font-pixel: ${fontPixel.style.fontFamily};
  --font-code: ${fontTerm.style.fontFamily};
  --brand-mark-image: url("${BRAND.logo}");
  --portal-image: url("${BRAND.assets.portal}");
}`;

function AppProviders({ Component, pageProps }: AppProps) {
  const { resolvedTheme } = useTheme();

  const wallets: Adapter[] = useMemo(() => {
    return [new PhantomWalletAdapter(), new SolflareWalletAdapter()].filter(
      (item) => item && item.name && item.icon
    ) as Adapter[];
  }, []);

  const queryClient = useMemo(() => new QueryClient(), []);

  useWindowWidthListener();

  const walletTheme = resolvedTheme === 'light' ? 'light' : 'dark';

  return (
    <QueryClientProvider client={queryClient}>
      <UnifiedWalletProvider
        wallets={wallets}
        config={{
          env: WALLET_NETWORK,
          autoConnect: true,
          metadata: {
            name: BRAND.name,
            description: BRAND.description,
            url: BRAND.url,
            iconUrls: [
              `${BRAND.url}${walletTheme === 'light' ? BRAND.assets.iconLight : BRAND.assets.iconDark}`,
            ],
          },
          // notificationCallback: WalletNotification,
          theme: walletTheme,
          lang: 'en',
          walletModalAttachments: { footer: <WalletModalBranding /> },
        }}
      >
        <Head>
          <title>{`${BRAND.longName} | ${BRAND.headline.top} ${BRAND.headline.bottom}`}</title>
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <meta
            key="og:title"
            property="og:title"
            content={`${BRAND.name}: ${BRAND.headline.top} ${BRAND.headline.bottom}`}
          />
          <meta key="og:description" property="og:description" content={BRAND.description} />
          {/* Default share card (brand); coin pages replace these via the same keys */}
          <meta
            key="og:image"
            property="og:image"
            content={`${BRAND.url}/api/og/brand?v=${BRAND.shareImageVersion}`}
          />
          <meta key="og:image:width" property="og:image:width" content="1200" />
          <meta key="og:image:height" property="og:image:height" content="630" />
          <meta key="twitter:card" name="twitter:card" content="summary_large_image" />
          <meta
            key="twitter:image"
            name="twitter:image"
            content={`${BRAND.url}/api/og/brand?v=${BRAND.shareImageVersion}`}
          />
        </Head>
        <style dangerouslySetInnerHTML={{ __html: fontRootStyle }} />
        <Toaster
          theme={walletTheme}
          position="bottom-right"
          mobileOffset={{ bottom: 84 }}
          closeButton
          icons={{
            // eslint-disable-next-line @next/next/no-img-element
            success: <img src={BRAND.assets.markSmall} alt="" className="h-5 w-5" />,
            error: <span className="iconify h-5 w-5 text-rose ph--warning-circle-fill" />,
          }}
          toastOptions={{
            classNames: {
              toast:
                '!rounded-md !border !border-neutral-800 !bg-neutral-950 !text-foreground !shadow-2xl !font-sans',
              title: '!font-term !text-[13px] !font-semibold !uppercase !tracking-wide',
              description: '!text-xs !text-neutral-400',
              actionButton: '!bg-primary !text-primary-950 !font-semibold',
              closeButton: '!border-neutral-800 !bg-neutral-900 !text-neutral-400',
            },
          }}
        />
        <GrainField />
        <Splash />
        <ThesisModal />
        <Component {...pageProps} />
      </UnifiedWalletProvider>
    </QueryClientProvider>
  );
}

export default function App(props: AppProps & { nonce?: string }) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="dark"
      forcedTheme="dark"
      enableSystem={false}
      disableTransitionOnChange
      nonce={props.nonce}
    >
      <AppProviders {...props} />
    </ThemeProvider>
  );
}

// Per-request script nonces require request-time HTML, including the public whitelist.
App.getInitialProps = async (context: AppContext) => {
  const initial = await NextApp.getInitialProps(context);
  const incoming = context.ctx.req?.headers['x-rinsed-nonce'];
  const nonce =
    typeof incoming === 'string' && /^[A-Za-z0-9+/]{32}$/.test(incoming)
      ? incoming
      : typeof document !== 'undefined'
        ? document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content
        : undefined;
  return { ...initial, nonce };
};
