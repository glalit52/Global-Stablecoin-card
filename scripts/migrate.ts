/**
 * Migration runner.
 *
 * Applies every file in db/migrations in filename order, inside a transaction,
 * recording each in schema_migrations. Re-running is a no-op.
 *   pnpm db:migrate          apply pending migrations
 *   pnpm db:reset            drop the schema and reapply from scratch
 */
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const MIGRATIONS_DIR = fileURLToPath(new URL('../db/migrations', import.meta.url));

const connectionString = process.env.DATABASE_URL
  ?? 'postgres://wealth:wealth@127.0.0.1:5432/wealthcard';

const run = async (): Promise<void> => {
  const reset = process.argv.includes('--reset');
  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    if (reset) {
      // Dropping the schema takes the enums and views with it, which a
      // table-by-table drop would leave behind.
      await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      console.log('schema dropped');
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);

    const { rows } = await client.query<{ version: string }>('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.version));

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    let count = 0;

    for (const file of files) {
      const version = path.basename(file, '.sql');
      if (applied.has(version)) continue;

      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
        await client.query('COMMIT');
        console.log(`applied ${version}`);
        count += 1;
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${version} failed: ${(err as Error).message}`, { cause: err });
      }
    }

    console.log(count === 0 ? 'database up to date' : `${count} migration(s) applied`);
  } finally {
    await client.end();
  }
};

run().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
