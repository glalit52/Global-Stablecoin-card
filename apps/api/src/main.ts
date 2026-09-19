/** Entry point. */
import { buildServer } from './server.js';

const main = async (): Promise<void> => {
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
