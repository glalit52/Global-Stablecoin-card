/**
 * Database access.
 *
 * Thin helpers over `pg` rather than an ORM. This codebase cares a great deal
 * about exact numerics and about which statements run inside which
 * transaction, and both are things an ORM tends to obscure.
 *
 * NUMERIC columns come back from `pg` as strings, which is exactly what we
 * want: they go straight into `Money.of` / `D` with no float in between.
 */
import pg from 'pg';
import { D, Decimal, Money } from '@wealthcard/core';

// Guard against a future dependency deciding NUMERIC should be a JS number.
pg.types.setTypeParser(1700, (v) => v);   // numeric
pg.types.setTypeParser(20, (v) => v);     // int8

export type Db = pg.Pool | pg.PoolClient;

export const createPool = (connectionString: string): pg.Pool =>
  new pg.Pool({
    connectionString,
    max: Number(process.env.PG_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

export const query = async <T extends pg.QueryResultRow = pg.QueryResultRow>(
  db: Db, sql: string, params: readonly unknown[] = [],
): Promise<T[]> => (await db.query<T>(sql, params as unknown[])).rows;

export const queryOne = async <T extends pg.QueryResultRow = pg.QueryResultRow>(
  db: Db, sql: string, params: readonly unknown[] = [],
): Promise<T | null> => (await query<T>(db, sql, params))[0] ?? null;

/**
 * Run `fn` inside a transaction on a dedicated connection.
 *
 * Nothing that writes to the ledger may run outside one of these: a settlement
 * that posts its journal entry but fails to move the facility balance would
 * leave the books provably wrong.
 */
export const transaction = async <T>(
  pool: pg.Pool, fn: (tx: pg.PoolClient) => Promise<T>,
): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
    throw err;
  } finally {
    client.release();
  }
};

/**
 * Take a row lock on a customer's facility for the duration of the
 * transaction. Every balance-changing path acquires this first, in the same
 * order, so two concurrent authorizations cannot both read the same available
 * credit and both approve.
 */
export const lockFacility = async (tx: pg.PoolClient, customerId: string): Promise<void> => {
  await tx.query('SELECT id FROM credit_facilities WHERE customer_id = $1 FOR UPDATE', [customerId]);
};

// --- Value conversion -------------------------------------------------------

export const money = (value: string | null | undefined, currency = 'USD'): Money =>
  Money.of(value ?? '0', currency);

export const decimal = (value: string | null | undefined): Decimal => D(value ?? '0');

export const decimalOrNull = (value: string | null | undefined): Decimal | null =>
  value === null || value === undefined ? null : D(value);

/** Serialise Money for a NUMERIC column at full precision. */
export const toNumeric = (m: Money | Decimal): string =>
  m instanceof Money ? m.toString() : m.toFixed();

export const toNumericOrNull = (m: Money | Decimal | null | undefined): string | null =>
  m === null || m === undefined ? null : toNumeric(m);
