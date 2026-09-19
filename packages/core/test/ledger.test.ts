import { describe, it, expect } from 'vitest';
import {
  ACCOUNTS, assertBalanced, balanceOf, cardRefundEntry, cardSettlementEntry, chargeOffEntry,
  computeBalances, credit, customerDebtFromLedger, D, debit, incomeStatement,
  interchangeEntry, interestAccrualEntry, liquidationProceedsEntry, Money, reconcile,
  repaymentEntry, rewardsAccrualEntry, rewardsRedemptionEntry, trialBalance,
  UnbalancedEntryError, type JournalEntry,
} from '../src/index.js';
import { T0, usd } from './helpers.js';

let seq = 0;
const ectx = (n = ++seq) => ({
  entryId: `je_${n}`, occurredAt: T0, idempotencyKey: `key_${n}`,
});

describe('double-entry invariants', () => {
  it('accepts a balanced entry', () => {
    expect(() => assertBalanced(cardSettlementEntry(ectx(), 'c1', 'tx1', usd('100'), 'Whole Foods'))).not.toThrow();
  });

  it('rejects an entry whose postings do not net to zero', () => {
    const bad: JournalEntry = {
      entryId: 'je_bad', kind: 'adjustment', currency: 'USD',
      postings: [
        debit(ACCOUNTS.CUSTOMER_RECEIVABLE, 'c1', usd('100'), 'x'),
        credit(ACCOUNTS.SETTLEMENT_CLEARING, null, usd('99'), 'y'),
      ],
      description: 'broken', referenceType: 'test', referenceId: 't',
      idempotencyKey: 'k', occurredAt: T0,
    };
    expect(() => assertBalanced(bad)).toThrow(UnbalancedEntryError);
  });

  it('rejects a single-sided entry', () => {
    const bad: JournalEntry = {
      entryId: 'je_single', kind: 'adjustment', currency: 'USD',
      postings: [debit(ACCOUNTS.SUSPENSE, null, usd('100'), 'x')],
      description: 'broken', referenceType: 'test', referenceId: 't',
      idempotencyKey: 'k', occurredAt: T0,
    };
    expect(() => assertBalanced(bad)).toThrow(UnbalancedEntryError);
  });

  it('rejects a posting in the wrong currency', () => {
    const bad: JournalEntry = {
      entryId: 'je_fx', kind: 'adjustment', currency: 'USD',
      postings: [
        debit(ACCOUNTS.CUSTOMER_RECEIVABLE, 'c1', usd('100'), 'x'),
        credit(ACCOUNTS.SETTLEMENT_CLEARING, null, Money.of('100', 'EUR'), 'y'),
      ],
      description: 'broken', referenceType: 'test', referenceId: 't',
      idempotencyKey: 'k', occurredAt: T0,
    };
    expect(() => assertBalanced(bad)).toThrow(/is in EUR, entry is USD/);
  });

  it('rejects a posting to an account outside the chart', () => {
    const bad: JournalEntry = {
      entryId: 'je_ghost', kind: 'adjustment', currency: 'USD',
      postings: [
        debit('9999', 'c1', usd('100'), 'x'),
        credit(ACCOUNTS.SETTLEMENT_CLEARING, null, usd('100'), 'y'),
      ],
      description: 'broken', referenceType: 'test', referenceId: 't',
      idempotencyKey: 'k', occurredAt: T0,
    };
    expect(() => assertBalanced(bad)).toThrow(/unknown account 9999/);
  });
});

describe('transaction lifecycle', () => {
  it('books a purchase, its interchange and its rewards consistently', () => {
    const entries = [
      cardSettlementEntry(ectx(), 'c1', 'tx1', usd('1200'), 'Whole Foods'),
      interchangeEntry(ectx(), 'tx1', usd('18.60')),
      rewardsAccrualEntry(ectx(), 'tx1', usd('36'), '3600'),
    ];
    const b = computeBalances(entries, 'USD');
    expect(balanceOf(b, ACCOUNTS.CUSTOMER_RECEIVABLE, 'c1', 'USD').toFixedString()).toBe('1200.00');
    // Revenue and liability accounts carry credit (negative) balances.
    expect(balanceOf(b, ACCOUNTS.INTERCHANGE_REVENUE, null, 'USD').toFixedString()).toBe('-18.60');
    expect(balanceOf(b, ACCOUNTS.REWARDS_LIABILITY, null, 'USD').toFixedString()).toBe('-36.00');
    expect(balanceOf(b, ACCOUNTS.REWARDS_EXPENSE, null, 'USD').toFixedString()).toBe('36.00');
    expect(trialBalance(entries, 'USD').balanced).toBe(true);
  });

  it('unwinds a purchase exactly on refund', () => {
    const entries = [
      cardSettlementEntry(ectx(), 'c1', 'tx1', usd('500'), 'Merchant'),
      cardRefundEntry(ectx(), 'c1', 'tx1', usd('500'), 'Merchant', false),
    ];
    const b = computeBalances(entries, 'USD');
    expect(balanceOf(b, ACCOUNTS.CUSTOMER_RECEIVABLE, 'c1', 'USD').isZero()).toBe(true);
    expect(trialBalance(entries, 'USD').balanced).toBe(true);
  });

  it('applies a repayment as fees, then interest, then principal', () => {
    const e = repaymentEntry(
      ectx(), 'c1', 'rep1', usd('1000'),
      { fees: usd('50'), interest: usd('150'), principal: usd('5000') }, 'fiat',
    );
    const b = computeBalances([e], 'USD');
    expect(balanceOf(b, ACCOUNTS.FEE_RECEIVABLE, 'c1', 'USD').toFixedString()).toBe('-50.00');
    expect(balanceOf(b, ACCOUNTS.INTEREST_RECEIVABLE, 'c1', 'USD').toFixedString()).toBe('-150.00');
    expect(balanceOf(b, ACCOUNTS.CUSTOMER_RECEIVABLE, 'c1', 'USD').toFixedString()).toBe('-800.00');
    expect(balanceOf(b, ACCOUNTS.CUSTOMER_CREDIT_BALANCE, 'c1', 'USD').isZero()).toBe(true);
  });

  it('parks an overpayment rather than driving a receivable negative', () => {
    const e = repaymentEntry(
      ectx(), 'c1', 'rep2', usd('1000'),
      { fees: Money.zero('USD'), interest: Money.zero('USD'), principal: usd('600') }, 'fiat',
    );
    const b = computeBalances([e], 'USD');
    expect(balanceOf(b, ACCOUNTS.CUSTOMER_RECEIVABLE, 'c1', 'USD').toFixedString()).toBe('-600.00');
    expect(balanceOf(b, ACCOUNTS.CUSTOMER_CREDIT_BALANCE, 'c1', 'USD').toFixedString()).toBe('-400.00');
  });

  it('balances a repayment that covers nothing outstanding', () => {
    const e = repaymentEntry(
      ectx(), 'c1', 'rep3', usd('250'),
      { fees: Money.zero('USD'), interest: Money.zero('USD'), principal: Money.zero('USD') }, 'stablecoin',
    );
    expect(() => assertBalanced(e)).not.toThrow();
  });

  it('books liquidation proceeds with their execution cost', () => {
    const e = liquidationProceedsEntry(ectx(), 'liq1', usd('98000'), usd('2000'));
    const b = computeBalances([e], 'USD');
    expect(balanceOf(b, ACCOUNTS.LIQUIDATION_CLEARING, null, 'USD').toFixedString()).toBe('98000.00');
    expect(balanceOf(b, ACCOUNTS.LIQUIDATION_COST_EXPENSE, null, 'USD').toFixedString()).toBe('2000.00');
    expect(balanceOf(b, ACCOUNTS.TREASURY_CASH, null, 'USD').toFixedString()).toBe('-100000.00');
  });

  it('redeems points against the receivable', () => {
    const entries = [
      rewardsAccrualEntry(ectx(), 'tx1', usd('100'), '10000'),
      rewardsRedemptionEntry(ectx(), 'c1', 'red1', usd('100')),
    ];
    const b = computeBalances(entries, 'USD');
    expect(balanceOf(b, ACCOUNTS.REWARDS_LIABILITY, null, 'USD').isZero()).toBe(true);
    expect(balanceOf(b, ACCOUNTS.CUSTOMER_RECEIVABLE, 'c1', 'USD').toFixedString()).toBe('-100.00');
  });

  it('charges off a full balance', () => {
    const e = chargeOffEntry(ectx(), 'c1', 'fac1', usd('10000'), usd('300'), usd('50'));
    const b = computeBalances([e], 'USD');
    expect(balanceOf(b, ACCOUNTS.CREDIT_LOSS_EXPENSE, null, 'USD').toFixedString()).toBe('10350.00');
  });
});

describe('reconciliation', () => {
  const book = () => [
    cardSettlementEntry(ectx(), 'c1', 'tx1', usd('1200'), 'Whole Foods'),
    interchangeEntry(ectx(), 'tx1', usd('18.60')),
    interestAccrualEntry(ectx(), 'c1', 'fac1', usd('3.75')),
  ];

  it('finds no breaks when the ledger and the facility agree', () => {
    const breaks = reconcile(book(), 'USD', [
      { customerId: 'c1', principal: usd('1200'), interest: usd('3.75'), fees: Money.zero('USD') },
    ]);
    expect(breaks).toEqual([]);
  });

  it('catches a facility that has drifted from the ledger', () => {
    const breaks = reconcile(book(), 'USD', [
      { customerId: 'c1', principal: usd('1100'), interest: usd('3.75'), fees: Money.zero('USD') },
    ]);
    expect(breaks).toHaveLength(1);
    expect(breaks[0]!.kind).toBe('facility_mismatch');
    expect(breaks[0]!.amount!.toFixedString()).toBe('100.00');
  });

  it('catches a duplicated idempotency key', () => {
    const e = cardSettlementEntry(ectx(1), 'c1', 'tx1', usd('100'), 'M');
    const dup = { ...e, entryId: 'je_dup' };
    const breaks = reconcile([e, dup], 'USD', []);
    expect(breaks.some((b) => b.kind === 'duplicate_idempotency_key')).toBe(true);
  });

  it('catches an uncleared suspense balance', () => {
    const entries: JournalEntry[] = [{
      entryId: 'je_susp', kind: 'adjustment', currency: 'USD',
      postings: [
        debit(ACCOUNTS.SUSPENSE, null, usd('42'), 'unidentified'),
        credit(ACCOUNTS.TREASURY_CASH, null, usd('42'), 'unidentified'),
      ],
      description: 'unidentified receipt', referenceType: 'ops', referenceId: 'x',
      idempotencyKey: 'susp1', occurredAt: T0,
    }];
    const breaks = reconcile(entries, 'USD', []);
    expect(breaks.some((b) => b.kind === 'suspense_not_cleared')).toBe(true);
  });

  it('derives customer debt from postings alone', () => {
    const entries = [
      cardSettlementEntry(ectx(), 'c1', 'tx1', usd('1000'), 'M'),
      interestAccrualEntry(ectx(), 'c1', 'fac1', usd('10')),
      repaymentEntry(ectx(), 'c1', 'rep1', usd('400'),
        { fees: Money.zero('USD'), interest: usd('10'), principal: usd('1000') }, 'fiat'),
    ];
    const b = computeBalances(entries, 'USD');
    expect(customerDebtFromLedger(b, 'c1', 'USD').toFixedString()).toBe('610.00');
  });
});

describe('unit economics', () => {
  it('rolls revenue and cost into a margin', () => {
    const entries = [
      cardSettlementEntry(ectx(), 'c1', 'tx1', usd('10000'), 'M'),
      interchangeEntry(ectx(), 'tx1', usd('155')),
      interestAccrualEntry(ectx(), 'c1', 'fac1', usd('40')),
      rewardsAccrualEntry(ectx(), 'tx1', usd('100'), '10000'),
    ];
    const pnl = incomeStatement(entries, 'USD');
    expect(pnl.totalRevenue.toFixedString()).toBe('195.00');
    expect(pnl.totalExpense.toFixedString()).toBe('100.00');
    expect(pnl.grossProfit.toFixedString()).toBe('95.00');
    expect(pnl.grossMargin.toDecimalPlaces(3).toFixed()).toBe('0.487');
  });

  it('reports zero margin on an empty book without dividing by zero', () => {
    const pnl = incomeStatement([], 'USD');
    expect(pnl.grossMargin.toFixed()).toBe('0');
  });
});
