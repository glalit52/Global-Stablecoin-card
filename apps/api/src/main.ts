/** Entry point. */
import { buildServer } from './server.js';
import { runMigrations } from './migrate.js';
import { loadConfig } from './config.js';

const main = async (): Promise<void> => {
  // Migrate before serving. Container platforms give you one start command,
  // not a pre-deploy hook, and migrations are idempotent — so the server
  // brings its own schema up to date rather than depending on someone
  // remembering to run a separate step. Set RUN_MIGRATIONS_ON_BOOT=false where
  // a deployment pipeline owns that instead.
  if (process.env.RUN_MIGRATIONS_ON_BOOT !== 'false') {
    const { databaseUrl } = loadConfig();
    await runMigrations({
      connectionString: databaseUrl,
      log: (message) => console.log(`[migrate] ${message}`),
    });
  }

  const server = await buildServer();
  const { config } = server.ctx;

  const shutdown = async (signal: string): Promise<void> => {
    server.app.log.info({ signal }, 'shutting down');
    try {
      await server.close();
      process.exit(0);
    } catch (err) {
      server.app.log.error({ err }, 'shutdown failed');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await server.app.listen({ port: config.port, host: config.host });
  server.app.log.info(
    { port: config.port, aiModel: config.anthropicApiKey ? config.anthropicModel : 'deterministic-only' },
    'Global Wealth Card API listening',
  );
};

main().catch((err: unknown) => {
  console.error('failed to start:', err);
  process.exit(1);
});
