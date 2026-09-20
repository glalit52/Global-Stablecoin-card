/**
 * Local migration CLI.
 *
 *   pnpm db:migrate    apply pending migrations
 *   pnpm db:reset      drop the schema and reapply from scratch
 *
 * The implementation lives in the API package so that a production image can
 * run it with plain `node` after compilation.
 */
import { runMigrations } from '../apps/api/src/migrate.js';

runMigrations({
  connectionString: process.env.DATABASE_URL
    ?? 'postgres://wealth:wealth@127.0.0.1:5432/wealthcard',
  reset: process.argv.includes('--reset'),
}).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
