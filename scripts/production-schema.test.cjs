const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  { createRequire } = require('node:module');
const app = createRequire(path.resolve(__dirname, '../scaffolds/fun-launch/package.json')),
  { PGlite } = app('@electric-sql/pglite');
const {
  sql,
  constraintsByMeaning,
  readSchemaCatalog,
  compareSchema,
  sha,
} = require('./production-schema.cjs');
test('normalizes formatting without changing SQL string or identifier contents', () => {
  assert.equal(sql("CHECK (  label  =  'two  spaces'   )"), "CHECK ( label = 'two  spaces' )");
  assert.equal(
    sql('CREATE  INDEX "two  spaces"\n ON test (id)'),
    'CREATE INDEX "two  spaces" ON test (id)'
  );
  assert.notEqual(sql("CHECK (label='two  spaces')"), sql("CHECK (label='two spaces')"));
});
test('compares exact CHECK meanings once while retaining changed invariants and validation state', () => {
  const original = {
    table_name: 'journal',
    name: 'auto_check',
    type: 'c',
    validated: true,
    definition: 'CHECK (amount >= 0)',
  };
  const fresh = constraintsByMeaning([original, { ...original, name: 'named_migration_check' }]),
    restored = constraintsByMeaning([{ ...original, name: 'named_migration_check' }]);
  assert.deepEqual(fresh, restored);
  assert.notDeepEqual(
    fresh,
    constraintsByMeaning([{ ...original, definition: 'CHECK (amount > 0)' }])
  );
  assert.notDeepEqual(fresh, constraintsByMeaning([{ ...original, validated: false }]));
});
test('generated source contract matches all migrations and detects nullability/constraint/trigger changes in isolated SQL', async () => {
  const db = new PGlite();
  try {
    await db.waitReady;
    const dir = path.join(__dirname, 'migrations'),
      migrations = [];
    for (const file of fs
      .readdirSync(dir)
      .filter((file) => /^\d{3}-[a-z0-9-]+\.sql$/.test(file))
      .sort()) {
      const source = fs.readFileSync(path.join(dir, file), 'utf8').replace(/\r\n/g, '\n');
      await db.exec(source);
      migrations.push({ file, sha256: sha(source) });
    }
    const contract = JSON.parse(
        fs.readFileSync(path.join(__dirname, 'production-schema-contract.json'), 'utf8')
      ),
      client = { query: async (text, args) => db.query(text, args) };
    assert.deepEqual(contract.migrations, migrations);
    const catalog = await readSchemaCatalog(client);
    assert.deepEqual(compareSchema(contract.catalog, catalog), []);
    await db.exec('ALTER TABLE launch_coins ALTER COLUMN mode DROP NOT NULL');
    assert.ok(
      compareSchema(contract.catalog, await readSchemaCatalog(client)).some(
        (issue) => issue.category === 'columns'
      )
    );
    await db.exec(
      'ALTER TABLE launch_coins ALTER COLUMN mode SET NOT NULL; DROP TRIGGER launch_coin_immutable ON launch_coins'
    );
    assert.ok(
      compareSchema(contract.catalog, await readSchemaCatalog(client)).some(
        (issue) => issue.category === 'triggers'
      )
    );
    await db.exec(
      'ALTER TABLE financial_balances DROP CONSTRAINT financial_balances_accrued_check'
    );
    assert.ok(
      compareSchema(contract.catalog, await readSchemaCatalog(client)).some(
        (issue) => issue.category === 'constraints'
      )
    );
  } finally {
    await db.close();
  }
});
