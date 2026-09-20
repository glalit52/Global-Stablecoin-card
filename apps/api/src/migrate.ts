/**
 * Migration runner.
 *
 * Lives in the API package so it compiles alongside it: a production image can
 * then run migrations with plain `node`, without carrying a TypeScript loader
 * into the runtime layer. `scripts/migrate.ts` is a thin wrapper for local use.
 *
 * Applies every file in db/migrations in filename order, each inside its own
 * transaction, recording it in schema_migrations. Re-running is a no-op.
 */
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

// Resolves identically from src/ and from dist/ — both sit three levels below
// the repository root.
const MIGRATIONS_DIR = fileURLToPath(new URL('../../../db/migrations', import.meta.url));

export interface MigrateOptions {
  readonly connectionString: string;
  /** Drops and recreates the public schema first. Never do this in production. */
  readonly reset?: boolean;
  readonly log?: (message: string) => void;
}

export const runMigrations = async (opts: MigrateOptions): Promise<number> => {
  const log = opts.log ?? ((m: string) => console.log(m));
  const client = new pg.Client({ connectionString: opts.connectionString });
  await client.connect();

  try {
    if (opts.reset) {
      await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      log('schema dropped');
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
        log(`applied ${version}`);
        count += 1;
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${version} failed: ${(err as Error).message}`, { cause: err });
      }
    }

    log(count === 0 ? 'database up to date' : `${count} migration(s) applied`);
    return count;
  } finally {
    await client.end();
  }
};

/** CLI entry: `node apps/api/dist/migrate.js [--reset]`. */
const isDirectRun = process.argv[1] !== undefined
  && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;

if (isDirectRun) {
  runMigrations({
    connectionString: process.env.DATABASE_URL
      ?? 'postgres://wealth:wealth@127.0.0.1:5432/wealthcard',
    reset: process.argv.includes('--reset'),
  }).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
