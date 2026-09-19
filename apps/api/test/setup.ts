/**
 * Integration-test harness.
 *
 * Runs against a real Postgres, because the things most worth testing here —
 * the facility row lock under concurrent authorizations, idempotency via a
 * unique index, the four-eyes CHECK constraint — are database behaviours that
 * a mock would simply assert away.
 */
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';
import { MarketSimulator } from '@wealthcard/adapters';
import { buildServer, type BuiltServer } from '../src/server.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../db/migrations', import.meta.url));

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
  ?? 'postgres://wealth:wealth@127.0.0.1:5432/wealthcard_test';

export const resetDatabase = async (): Promise<void> => {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      await client.query(await readFile(path.join(MIGRATIONS_DIR, file), 'utf8'));
    }
  } finally {
    await client.end();
  }
};

export interface TestHarness extends BuiltServer {
  market: MarketSimulator;
  setNow: (d: Date) => void;
}

export const startTestServer = async (): Promise<TestHarness> => {
  const market = new MarketSimulator(7);
  // A fixed clock by default. Time-dependent behaviour is then something a
  // test opts into explicitly rather than something it races against.
  let now = new Date('2026-06-01T12:00:00.000Z');

  const server = await buildServer({
    config: {
      databaseUrl: TEST_DATABASE_URL,
      nodeEnv: 'test',
      anthropicApiKey: null,
      sessionTtlHours: 1,
      stepUpTtlMinutes: 5,
    },
    market,
    startWorkers: false,
    now: () => now,
  });

  return { ...server, market, setNow: (d: Date) => { now = d; } };
};

export interface ApiClient {
  (method: string, url: string, body?: unknown, token?: string): Promise<{
    status: number;
    body: Record<string, unknown>;
  }>;
}

export const makeClient = (server: BuiltServer): ApiClient =>
  async (method, url, body, token) => {
    const response = await server.app.inject({
      method: method as 'GET',
      url,
      ...(body !== undefined ? { payload: body as object } : {}),
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    let parsed: Record<string, unknown> = {};
    try {
      parsed = response.body ? JSON.parse(response.body) as Record<string, unknown> : {};
    } catch {
      parsed = { raw: response.body };
    }
    return { status: response.statusCode, body: parsed };
  };
