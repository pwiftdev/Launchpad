import NextDocument, {
  Html,
  Head,
  Main,
  NextScript,
  type DocumentContext,
  type DocumentInitialProps,
} from 'next/document';
import { BRAND } from '@/constants/brand';
import { NONCE_HEADER, validScriptNonce } from '@/server/securityHeaders';
import { SPLASH_BOOT_SCRIPT } from '@/lib/splash';

export default class Document extends NextDocument<DocumentInitialProps & { nonce?: string }> {
  static override async getInitialProps(context: DocumentContext) {
    const initial = await NextDocument.getInitialProps(context);
    const incoming = context.req?.headers[NONCE_HEADER];
    return { ...initial, nonce: validScriptNonce(incoming) ? incoming : undefined };
  }
  override render() {
    const { nonce } = this.props;
    return (
      <Html lang="en" suppressHydrationWarning>
        <Head nonce={nonce}>
          {nonce && <meta name="csp-nonce" content={nonce} />}
          <link rel="icon" href={BRAND.assets.favicon} type="image/png" sizes="32x32" />
          <link rel="icon" href="/favicon.ico" sizes="any" />
          <link rel="apple-touch-icon" href={BRAND.assets.appleTouch} sizes="180x180" />
          <link rel="manifest" href="/site.webmanifest" />
          {/* The mark and wordmark paint above the fold on the splash and top bar */}
          <link rel="preload" as="image" href={BRAND.assets.markSmall} type="image/webp" />
          <link rel="preload" as="image" href={BRAND.logo} type="image/webp" />
          <link rel="preload" as="image" href={BRAND.wordmarkImage} type="image/webp" />
          <meta name="theme-color" content={BRAND.themeColor} />
          <meta name="description" content={BRAND.description} />
          <meta property="og:site_name" content={BRAND.name} />
          <meta property="og:type" content="website" />
          <meta name="twitter:site" content={BRAND.xHandle} />
          {/* Hide the first-load splash before paint if it was already shown this session */}
          <script
            nonce={nonce}
            dangerouslySetInnerHTML={{
              __html: SPLASH_BOOT_SCRIPT,
            }}
          />
        </Head>
        <body className="antialiased">
          <Main />
          <NextScript nonce={nonce} />
        </body>
      </Html>
    );
  }
}
