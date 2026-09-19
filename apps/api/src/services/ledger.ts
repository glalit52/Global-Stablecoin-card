/**
 * Ledger persistence.
 *
 * The domain core builds balanced journal entries; this module writes them
 * and keeps the denormalised facility balances in step. Both happen inside
 * one caller-supplied transaction — a settlement that posted its entry but
 * failed to move the facility balance would leave the books provably wrong,
 * and the reconciler would find it the next morning.
 */
import type pg from 'pg';
import {
  ACCOUNTS, assertBalanced, computeBalances, D, incomeStatement, Money, reconcile,
  trialBalance, type JournalEntry, type ReconciliationBreak,
} from '@wealthcard/core';
import { money, query, queryOne, toNumeric, type Db } from '../db.js';
import { conflict } from '../errors.js';

/**
 * Persist a balanced entry.
 *
 * Returns `duplicate` rather than throwing when the idempotency key has
 * already been posted: card networks and webhook senders retry, and the
 * correct response to a retry is the original outcome, not an error.
 */
export const postEntry = async (
  tx: pg.PoolClient, entry: JournalEntry,
): Promise<{ entryId: string; duplicate: boolean }> => {
  assertBalanced(entry);

  const existing = await queryOne<{ id: string }>(
    tx, 'SELECT id FROM journal_entries WHERE idempotency_key = $1', [entry.idempotencyKey],
  );
  if (existing) return { entryId: existing.id, duplicate: true };

  const row = await queryOne<{ id: string }>(
    tx,
    `INSERT INTO journal_entries
       (kind, currency, description, reference_type, reference_id, idempotency_key, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [entry.kind, entry.currency, entry.description, entry.referenceType,
     entry.referenceId, entry.idempotencyKey, entry.occurredAt],
  );

  // Lost a race with a concurrent poster of the same business event.
  if (!row) {
    const winner = await queryOne<{ id: string }>(
      tx, 'SELECT id FROM journal_entries WHERE idempotency_key = $1', [entry.idempotencyKey],
    );
    if (!winner) throw conflict('ledger_race', 'Could not resolve a concurrent ledger write');
    return { entryId: winner.id, duplicate: true };
  }

  for (const posting of entry.postings) {
    await query(
      tx,
      `INSERT INTO postings (entry_id, account_code, customer_id, amount, memo, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [row.id, posting.accountCode, posting.customerId, toNumeric(posting.amount),
       posting.memo, entry.occurredAt],
    );
  }

  return { entryId: row.id, duplicate: false };
};

/**
 * Recompute a facility's balances from the postings.
 *
 * Deliberately derived rather than incremented. An `UPDATE ... SET balance =
 * balance + x` drifts the moment any path forgets to call it; recomputing from
 * the ledger cannot drift, because the ledger is the record.
 */
export const syncFacilityFromLedger = async (
  tx: pg.PoolClient, customerId: string, currency = 'USD',
): Promise<{ principal: Money; interest: Money; fees: Money; creditBalance: Money }> => {
  const rows = await query<{ account_code: string; balance: string }>(
    tx,
    `SELECT account_code, COALESCE(SUM(amount),0)::text AS balance
       FROM postings WHERE customer_id = $1 GROUP BY account_code`,
    [customerId],
  );
  const byAccount = new Map(rows.map((r) => [r.account_code, r.balance]));
  const read = (code: string) => money(byAccount.get(code) ?? '0', currency);

  const principal = read(ACCOUNTS.CUSTOMER_RECEIVABLE).clampPositive();
  const interest = read(ACCOUNTS.INTEREST_RECEIVABLE).clampPositive();
  const fees = read(ACCOUNTS.FEE_RECEIVABLE).clampPositive();
  // A credit balance is held as a liability, so it carries a credit sign.
  const creditBalance = read(ACCOUNTS.CUSTOMER_CREDIT_BALANCE).negated().clampPositive();

  await query(
    tx,
    `UPDATE credit_facilities
        SET principal_balance = $2, interest_balance = $3, fee_balance = $4, updated_at = now()
      WHERE customer_id = $1`,
    [customerId, toNumeric(principal), toNumeric(interest), toNumeric(fees)],
  );

  return { principal, interest, fees, creditBalance };
};

/** Recompute open authorization holds from the authorizations table. */
export const syncHolds = async (
  tx: pg.PoolClient, customerId: string, currency = 'USD',
): Promise<Money> => {
  const row = await queryOne<{ total: string }>(
    tx,
    `SELECT COALESCE(SUM(billing_amount),0)::text AS total
       FROM authorizations
      WHERE customer_id = $1 AND approved AND NOT hold_released`,
    [customerId],
  );
  const holds = money(row?.total ?? '0', currency);
  await query(
    tx, 'UPDATE credit_facilities SET holds_total = $2, updated_at = now() WHERE customer_id = $1',
    [customerId, toNumeric(holds)],
  );
  return holds;
};

/** Load every entry back out of the database, for reconciliation and reporting. */
export const loadEntries = async (
  db: Db, opts: { since?: Date; customerId?: string } = {},
): Promise<JournalEntry[]> => {
  const rows = await query<{
    id: string; kind: string; currency: string; description: string;
    reference_type: string; reference_id: string; idempotency_key: string; occurred_at: Date;
  }>(
    db,
    `SELECT DISTINCT e.* FROM journal_entries e
       LEFT JOIN postings p ON p.entry_id = e.id
      WHERE ($1::timestamptz IS NULL OR e.occurred_at >= $1)
        AND ($2::uuid IS NULL OR p.customer_id = $2)
      ORDER BY e.occurred_at, e.id`,
    [opts.since ?? null, opts.customerId ?? null],
  );
  if (rows.length === 0) return [];

  const postings = await query<{
    entry_id: string; account_code: string; customer_id: string | null; amount: string; memo: string;
  }>(
    db,
    `SELECT entry_id, account_code, customer_id, amount::text, memo
       FROM postings WHERE entry_id = ANY($1::uuid[]) ORDER BY id`,
    [rows.map((r) => r.id)],
  );

  const byEntry = new Map<string, typeof postings>();
  for (const p of postings) {
    const list = byEntry.get(p.entry_id) ?? [];
    list.push(p);
    byEntry.set(p.entry_id, list);
  }

  return rows.map((r) => ({
    entryId: r.id,
    kind: r.kind as JournalEntry['kind'],
    currency: r.currency,
    description: r.description,
    referenceType: r.reference_type,
    referenceId: r.reference_id,
    idempotencyKey: r.idempotency_key,
    occurredAt: r.occurred_at,
    postings: (byEntry.get(r.id) ?? []).map((p) => ({
      accountCode: p.account_code,
      customerId: p.customer_id,
      amount: money(p.amount, r.currency),
      memo: p.memo,
    })),
  }));
};

export interface ReconciliationReport {
  readonly entryCount: number;
  readonly trialBalance: ReturnType<typeof trialBalance>;
  readonly breaks: readonly ReconciliationBreak[];
  readonly income: ReturnType<typeof incomeStatement>;
  readonly runAt: Date;
}

/** The daily proof (PRD §22 "partner settlement reconciliation"). */
export const runReconciliation = async (
  db: Db, currency = 'USD',
): Promise<ReconciliationReport> => {
  const entries = await loadEntries(db);
  const facilities = await query<{
    customer_id: string; principal_balance: string; interest_balance: string; fee_balance: string;
  }>(db, 'SELECT customer_id, principal_balance::text, interest_balance::text, fee_balance::text FROM credit_facilities');

  const breaks = reconcile(entries, currency, facilities.map((f) => ({
    customerId: f.customer_id,
    principal: money(f.principal_balance, currency),
    interest: money(f.interest_balance, currency),
    fees: money(f.fee_balance, currency),
  })));

  return {
    entryCount: entries.length,
    trialBalance: trialBalance(entries, currency),
    breaks,
    income: incomeStatement(entries, currency),
    runAt: new Date(),
  };
};

export { computeBalances, D };
