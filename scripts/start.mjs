import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const { validateEnv, validatePublicBuildEnvironment } = createRequire(import.meta.url)(
  '../scaffolds/fun-launch/.next/standalone/scripts/validate-env.cjs'
);

validateEnv();
validatePublicBuildEnvironment(
  JSON.parse(
    readFileSync(
      new URL(
        '../scaffolds/fun-launch/.next/standalone/scripts/public-build-environment.json',
        import.meta.url
      ),
      'utf8'
    )
  )
);
process.env.NODE_ENV = 'production';
process.env.HOSTNAME = '0.0.0.0';
process.env.PORT ||= '3000';
await import('../scaffolds/fun-launch/.next/standalone/scaffolds/fun-launch/server.js');
