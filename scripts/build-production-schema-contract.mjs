// Development artifact generation only; no external database or environment configuration is read.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { readSchemaCatalog, sha } from './production-schema.cjs';
const require = createRequire(new URL('../scaffolds/fun-launch/package.json', import.meta.url));
const { PGlite } = require('@electric-sql/pglite');
if (process.argv.length !== 2) throw new Error('No arguments accepted');
const dir = new URL('./migrations/', import.meta.url),
  migrations = [];
const db = new PGlite();
try {
  await db.waitReady;
  for (const file of (await readdir(dir))
    .filter((file) => /^\d{3}-[a-z0-9-]+\.sql$/.test(file))
    .sort()) {
    const source = (await readFile(new URL(file, dir), 'utf8')).replace(/\r\n/g, '\n');
    await db.exec(source);
    migrations.push({ file, sha256: sha(source) });
  }
  const catalog = await readSchemaCatalog({ query: async (text, args) => db.query(text, args) });
  const contract = { version: 1, sourceNormalization: 'LF', migrations, catalog };
  await writeFile(
    new URL('./production-schema-contract.json', import.meta.url),
    JSON.stringify(contract, null, 2) + '\n'
  );
  console.log(
    JSON.stringify({
      generated: true,
      inMemoryOnly: true,
      migrations: migrations.length,
      tables: catalog.tables.length,
    })
  );
} finally {
  await db.close();
}
