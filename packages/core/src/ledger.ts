/**
 * Double-entry ledger (PRD §28 "double-entry ledgers and automated reconciliation").
 *
 * Every movement of value in the platform is a journal entry whose debits
 * equal its credits, exactly, in the same currency. Balances are never stored
 * as an authoritative figure that code can assign to — they are derived by
 * replaying postings. That is what makes the books provable rather than
 * merely plausible.
 *
 * Sign convention: postings carry a signed amount. A positive amount is a
 * debit, a negative amount is a credit. An entry balances when its postings
 * sum to exactly zero.
 */
import { D, Money, ZERO } from './money.js';

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

export interface LedgerAccountDef {
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  /** True when one instance exists per customer rather than per platform. */
  readonly perCustomer: boolean;
  readonly description: string;
}

/** Chart of accounts. Codes are stable and must never be reused. */
export const CHART_OF_ACCOUNTS: readonly LedgerAccountDef[] = [
  { code: '1000', name: 'Customer Receivable', type: 'asset', perCustomer: true, description: 'Principal drawn by the customer on their credit facility.' },
  { code: '1010', name: 'Interest Receivable', type: 'asset', perCustomer: true, description: 'Accrued but unpaid interest.' },
  { code: '1020', name: 'Fee Receivable', type: 'asset', perCustomer: true, description: 'Accrued but unpaid fees.' },
  { code: '1100', name: 'Network Settlement Clearing', type: 'asset', perCustomer: false, description: 'Funds in flight between the card network and the platform.' },
  { code: '1200', name: 'Treasury Cash', type: 'asset', perCustomer: false, description: 'Platform operating and funding cash.' },
  { code: '1300', name: 'Collateral Liquidation Clearing', type: 'asset', perCustomer: false, description: 'Proceeds in flight from a collateral sale.' },
  { code: '1900', name: 'Suspense', type: 'asset', perCustomer: false, description: 'Unidentified items pending investigation. Must be cleared daily.' },

  { code: '2000', name: 'Funding Facility', type: 'liability', perCustomer: false, description: 'Amounts owed to the lending partner funding customer balances.' },
  { code: '2100', name: 'Rewards Liability', type: 'liability', perCustomer: false, description: 'Points earned and not yet redeemed, at accrual cost.' },
  { code: '2200', name: 'Customer Credit Balance', type: 'liability', perCustomer: true, description: 'Customer overpayment held on account.' },

  { code: '4000', name: 'Interchange Revenue', type: 'revenue', perCustomer: false, description: 'Interchange earned on settled card spend.' },
  { code: '4100', name: 'Interest Revenue', type: 'revenue', perCustomer: false, description: 'Interest earned on revolving balances.' },
  { code: '4200', name: 'FX Revenue', type: 'revenue', perCustomer: false, description: 'Margin earned on cross-currency transactions.' },
  { code: '4300', name: 'Membership Revenue', type: 'revenue', perCustomer: false, description: 'Annual and subscription fees.' },

  { code: '5000', name: 'Rewards Expense', type: 'expense', perCustomer: false, description: 'Cost of points accrued to customers.' },
  { code: '5100', name: 'Credit Loss Expense', type: 'expense', perCustomer: false, description: 'Charged-off customer balances.' },
  { code: '5200', name: 'Liquidation Cost Expense', type: 'expense', perCustomer: false, description: 'Slippage and venue fees on forced collateral sales.' },
  { code: '5300', name: 'Fraud Loss Expense', type: 'expense', perCustomer: false, description: 'Losses from confirmed fraud and unrecovered disputes.' },
] as const;

export const ACCOUNT_BY_CODE = new Map(CHART_OF_ACCOUNTS.map((a) => [a.code, a]));

export const ACCOUNTS = {
  CUSTOMER_RECEIVABLE: '1000',
  INTEREST_RECEIVABLE: '1010',
  FEE_RECEIVABLE: '1020',
  SETTLEMENT_CLEARING: '1100',
  TREASURY_CASH: '1200',
  LIQUIDATION_CLEARING: '1300',
  SUSPENSE: '1900',
  FUNDING_FACILITY: '2000',
  REWARDS_LIABILITY: '2100',
  CUSTOMER_CREDIT_BALANCE: '2200',
  INTERCHANGE_REVENUE: '4000',
  INTEREST_REVENUE: '4100',
  FX_REVENUE: '4200',
  MEMBERSHIP_REVENUE: '4300',
  REWARDS_EXPENSE: '5000',
  CREDIT_LOSS_EXPENSE: '5100',
  LIQUIDATION_COST_EXPENSE: '5200',
  FRAUD_LOSS_EXPENSE: '5300',
} as const;

export interface Posting {
  readonly accountCode: string;
  /** Null for platform-level accounts. */
  readonly customerId: string | null;
  /** Positive = debit, negative = credit. */
  readonly amount: Money;
  readonly memo: string;
}

export type JournalEntryKind =
  | 'card_settlement' | 'card_refund' | 'card_reversal' | 'interchange'
  | 'interest_accrual' | 'fee_assessment' | 'repayment' | 'overpayment_refund'
  | 'rewards_accrual' | 'rewards_redemption' | 'rewards_reversal'
  | 'liquidation_proceeds' | 'liquidation_cost' | 'charge_off'
  | 'fraud_writeoff' | 'membership_fee' | 'funding_draw' | 'funding_repay'
  | 'adjustment';

export interface JournalEntry {
  readonly entryId: string;
  readonly kind: JournalEntryKind;
  readonly currency: string;
  readonly postings: readonly Posting[];
  readonly description: string;
  /** Links the entry back to the transaction, repayment or liquidation. */
  readonly referenceType: string;
  readonly referenceId: string;
  /** Natural key for the business event. Re-posting the same key is a no-op. */
  readonly idempotencyKey: string;
  readonly occurredAt: Date;
}

export class UnbalancedEntryError extends Error {
  constructor(entryId: string, residual: Money) {
    super(`journal entry ${entryId} does not balance: residual ${residual.toString()} ${residual.currency}`);
    this.name = 'UnbalancedEntryError';
  }
}

/** Throws unless debits and credits net to exactly zero. */
export const assertBalanced = (entry: JournalEntry): void => {
  if (entry.postings.length < 2) {
    throw new UnbalancedEntryError(entry.entryId, Money.zero(entry.currency));
  }
  let residual = Money.zero(entry.currency);
  for (const p of entry.postings) {
    if (p.amount.currency !== entry.currency) {
      throw new TypeError(
        `journal entry ${entry.entryId}: posting to ${p.accountCode} is in ${p.amount.currency}, entry is ${entry.currency}`,
      );
    }
    if (!ACCOUNT_BY_CODE.has(p.accountCode)) {
      throw new RangeError(`journal entry ${entry.entryId}: unknown account ${p.accountCode}`);
    }
    residual = residual.plus(p.amount);
  }
  if (!residual.isZero()) throw new UnbalancedEntryError(entry.entryId, residual);
};

const debit = (accountCode: string, customerId: string | null, amount: Money, memo: string): Posting =>
  ({ accountCode, customerId, amount, memo });

const credit = (accountCode: string, customerId: string | null, amount: Money, memo: string): Posting =>
  ({ accountCode, customerId, amount: amount.negated(), memo });

export { debit, credit };

export interface EntryContext {
  readonly entryId: string;
  readonly occurredAt: Date;
  readonly idempotencyKey: string;
}

/**
 * Card purchase settles. The customer's receivable grows; the network
 * settlement account is drawn down to pay the acquirer.
 */
export const cardSettlementEntry = (
  ctx: EntryContext, customerId: string, transactionId: string,
  billingAmount: Money, merchantName: string,
): JournalEntry => {
  const entry: JournalEntry = {
    entryId: ctx.entryId, kind: 'card_settlement', currency: billingAmount.currency,
    postings: [
      debit(ACCOUNTS.CUSTOMER_RECEIVABLE, customerId, billingAmount, `Purchase at ${merchantName}`),
      credit(ACCOUNTS.SETTLEMENT_CLEARING, null, billingAmount, `Network settlement for ${transactionId}`),
    ],
    description: `Card purchase at ${merchantName}`,
    referenceType: 'transaction', referenceId: transactionId,
    idempotencyKey: ctx.idempotencyKey, occurredAt: ctx.occurredAt,
  };
  assertBalanced(entry);
  return entry;
};

/** Interchange earned on that settled spend. */
export const interchangeEntry = (
  ctx: EntryContext, transactionId: string, interchange: Money,
): JournalEntry => {
  const entry: JournalEntry = {
    entryId: ctx.entryId, kind: 'interchange', currency: interchange.currency,
    postings: [
      debit(ACCOUNTS.SETTLEMENT_CLEARING, null, interchange, `Interchange on ${transactionId}`),
      credit(ACCOUNTS.INTERCHANGE_REVENUE, null, interchange, `Interchange on ${transactionId}`),
    ],
    description: 'Interchange revenue',
    referenceType: 'transaction', referenceId: transactionId,
    idempotencyKey: ctx.idempotencyKey, occurredAt: ctx.occurredAt,
  };
  assertBalanced(entry);
  return entry;
};

/** FX margin retained on a cross-currency transaction. */
export const fxRevenueEntry = (
  ctx: EntryContext, customerId: string, transactionId: string, fxFee: Money,
): JournalEntry => {
  const entry: JournalEntry = {
    entryId: ctx.entryId, kind: 'card_settlement', currency: fxFee.currency,
    postings: [
      debit(ACCOUNTS.CUSTOMER_RECEIVABLE, customerId, fxFee, `FX margin on ${transactionId}`),
      credit(ACCOUNTS.FX_REVENUE, null, fxFee, `FX margin on ${transactionId}`),
    ],
    description: 'Foreign exchange margin',
    referenceType: 'transaction', referenceId: transactionId,
    idempotencyKey: ctx.idempotencyKey, occurredAt: ctx.occurredAt,
  };
  assertBalanced(entry);
  return entry;
};

/** Refund or reversal — the mirror of a settlement. */
export const cardRefundEntry = (
  ctx: EntryContext, customerId: string, transactionId: string,
  amount: Money, merchantName: string, reversal: boolean,
): JournalEntry => {
  const entry: JournalEntry = {
    entryId: ctx.entryId, kind: reversal ? 'card_reversal' : 'card_refund', currency: amount.currency,
    postings: [
      debit(ACCOUNTS.SETTLEMENT_CLEARING, null, amount, `Refund from ${merchantName}`),
      credit(ACCOUNTS.CUSTOMER_RECEIVABLE, customerId, amount, `Refund for ${transactionId}`),
    ],
    description: `${reversal ? 'Reversal' : 'Refund'} from ${merchantName}`,
    referenceType: 'transaction', referenceId: transactionId,
    idempotencyKey: ctx.idempotencyKey, occurredAt: ctx.occurredAt,
  };
  assertBalanced(entry);
  return entry;
};

export const interestAccrualEntry = (
  ctx: EntryContext, customerId: string, facilityId: string, interest: Money,
): JournalEntry => {
  const entry: JournalEntry = {
    entryId: ctx.entryId, kind: 'interest_accrual', currency: interest.currency,
    postings: [
      debit(ACCOUNTS.INTEREST_RECEIVABLE, customerId, interest, 'Daily interest accrual'),
      credit(ACCOUNTS.INTEREST_REVENUE, null, interest, 'Daily interest accrual'),
    ],
    description: 'Interest accrual',
    referenceType: 'facility', referenceId: facilityId,
    idempotencyKey: ctx.idempotencyKey, occurredAt: ctx.occurredAt,
  };
  assertBalanced(entry);
  return entry;
};

export const membershipFeeEntry = (
  ctx: EntryContext, customerId: string, facilityId: string, fee: Money, label: string,
): JournalEntry => {
  const entry: JournalEntry = {
    entryId: ctx.entryId, kind: 'membership_fee', currency: fee.currency,
    postings: [
      debit(ACCOUNTS.FEE_RECEIVABLE, customerId, fee, label),
      credit(ACCOUNTS.MEMBERSHIP_REVENUE, null, fee, label),
    ],
    description: label,
    referenceType: 'facility', referenceId: facilityId,
    idempotencyKey: ctx.idempotencyKey, occurredAt: ctx.occurredAt,
  };
  assertBalanced(entry);
  return entry;
};

/**
 * Customer repayment. Applied in regulatory order — fees, then interest, then
 * principal — with anything left over parked as a credit balance rather than
 * silently reducing a receivable that is already at zero.
 */
export const repaymentEntry = (
  ctx: EntryContext, customerId: string, repaymentId: string, received: Money,
  outstanding: { fees: Money; interest: Money; principal: Money },
  source: 'fiat' | 'stablecoin' | 'liquidation',
): JournalEntry => {
  const currency = received.currency;
  const postings: Posting[] = [
    debit(
      source === 'liquidation' ? ACCOUNTS.LIQUIDATION_CLEARING : ACCOUNTS.TREASURY_CASH,
      null, received, `Repayment received (${source})`,
    ),
  ];

  let remaining = received;
  const applyTo = (account: string, owed: Money, label: string) => {
    if (!remaining.isPositive() || !owed.isPositive()) return;
    const applied = remaining.min(owed);
    postings.push(credit(account, customerId, applied, label));
    remaining = remaining.minus(applied);
  };

  applyTo(ACCOUNTS.FEE_RECEIVABLE, outstanding.fees, 'Applied to fees');
  applyTo(ACCOUNTS.INTEREST_RECEIVABLE, outstanding.interest, 'Applied to interest');
  applyTo(ACCOUNTS.CUSTOMER_RECEIVABLE, outstanding.principal, 'Applied to principal');

  if (remaining.isPositive()) {
    postings.push(credit(ACCOUNTS.CUSTOMER_CREDIT_BALANCE, customerId, remaining, 'Overpayment held on account'));
  }

  const entry: JournalEntry = {
    entryId: ctx.entryId, kind: 'repayment', currency, postings,
    description: `Repayment (${source})`,
    referenceType: 'repayment', referenceId: repaymentId,
    idempotencyKey: ctx.idempotencyKey, occurredAt: ctx.occurredAt,
  };
  assertBalanced(entry);
  return entry;
};

/** Points accrue as a real expense and a real liability the moment they are earned. */
export const rewardsAccrualEntry = (
  ctx: EntryContext, transactionId: string, accrualCost: Money, points: string,
): JournalEntry => {
  const entry: JournalEntry = {
    entryId: ctx.entryId, kind: 'rewards_accrual', currency: accrualCost.currency,
    postings: [
      debit(ACCOUNTS.REWARDS_EXPENSE, null, accrualCost, `${points} points earned`),
      credit(ACCOUNTS.REWARDS_LIABILITY, null, accrualCost, `${points} points earned`),
    ],
    description: 'Rewards accrual',
    referenceType: 'transaction', referenceId: transactionId,
    idempotencyKey: ctx.idempotencyKey, occurredAt: ctx.occurredAt,
  };
  assertBalanced(entry);
  return entry;
};

/** Redemption as statement credit: the liability is released against the receivable. */
export const rewardsRedemptionEntry = (
  ctx: EntryContext, customerId: string, redemptionId: string, value: Money,
): JournalEntry => {
  const entry: JournalEntry = {
    entryId: ctx.entryId, kind: 'rewards_redemption', currency: value.currency,
    postings: [
      debit(ACCOUNTS.REWARDS_LIABILITY, null, value, 'Points redeemed'),
      credit(ACCOUNTS.CUSTOMER_RECEIVABLE, customerId, value, 'Statement credit from points'),
    ],
    description: 'Rewards redemption as statement credit',
    referenceType: 'redemption', referenceId: redemptionId,
    idempotencyKey: ctx.idempotencyKey, occurredAt: ctx.occurredAt,
  };
  assertBalanced(entry);
  return entry;
};

/** Proceeds of a forced sale arrive, and the execution cost is recognised. */
export const liquidationProceedsEntry = (
  ctx: EntryContext, liquidationId: string, netProceeds: Money, executionCost: Money,
): JournalEntry => {
  const gross = netProceeds.plus(executionCost);
  const entry: JournalEntry = {
    entryId: ctx.entryId, kind: 'liquidation_proceeds', currency: netProceeds.currency,
    postings: [
      debit(ACCOUNTS.LIQUIDATION_CLEARING, null, netProceeds, 'Net sale proceeds'),
      debit(ACCOUNTS.LIQUIDATION_COST_EXPENSE, null, executionCost, 'Slippage and venue fees'),
      credit(ACCOUNTS.TREASURY_CASH, null, gross, 'Collateral sold at custodian'),
    ],
    description: 'Collateral liquidation',
    referenceType: 'liquidation', referenceId: liquidationId,
    idempotencyKey: ctx.idempotencyKey, occurredAt: ctx.occurredAt,
  };
  assertBalanced(entry);
  return entry;
};

export const chargeOffEntry = (
  ctx: EntryContext, customerId: string, facilityId: string,
  principal: Money, interest: Money, fees: Money,
): JournalEntry => {
  const total = principal.plus(interest).plus(fees);
  const postings: Posting[] = [debit(ACCOUNTS.CREDIT_LOSS_EXPENSE, null, total, 'Charge-off')];
  if (principal.isPositive()) postings.push(credit(ACCOUNTS.CUSTOMER_RECEIVABLE, customerId, principal, 'Principal charged off'));
  if (interest.isPositive()) postings.push(credit(ACCOUNTS.INTEREST_RECEIVABLE, customerId, interest, 'Interest charged off'));
  if (fees.isPositive()) postings.push(credit(ACCOUNTS.FEE_RECEIVABLE, customerId, fees, 'Fees charged off'));

  const entry: JournalEntry = {
    entryId: ctx.entryId, kind: 'charge_off', currency: total.currency, postings,
    description: 'Balance charged off',
    referenceType: 'facility', referenceId: facilityId,
    idempotencyKey: ctx.idempotencyKey, occurredAt: ctx.occurredAt,
  };
  assertBalanced(entry);
  return entry;
};

// ---------------------------------------------------------------------------
// Balances and reconciliation
// ---------------------------------------------------------------------------

export interface AccountBalance {
  readonly accountCode: string;
  readonly customerId: string | null;
  readonly balance: Money;
}

const keyOf = (accountCode: string, customerId: string | null) => `${accountCode}::${customerId ?? '-'}`;

/** Replay postings into balances. The only legitimate way to know a balance. */
export const computeBalances = (
  entries: readonly JournalEntry[], currency: string,
): Map<string, AccountBalance> => {
  const balances = new Map<string, AccountBalance>();
  for (const entry of entries) {
    for (const p of entry.postings) {
      const key = keyOf(p.accountCode, p.customerId);
      const prev = balances.get(key);
      balances.set(key, {
        accountCode: p.accountCode,
        customerId: p.customerId,
        balance: (prev?.balance ?? Money.zero(currency)).plus(p.amount),
      });
    }
  }
  return balances;
};

export const balanceOf = (
  balances: ReadonlyMap<string, AccountBalance>, accountCode: string,
  customerId: string | null, currency: string,
): Money => balances.get(keyOf(accountCode, customerId))?.balance ?? Money.zero(currency);

export interface TrialBalance {
  readonly totalDebits: Money;
  readonly totalCredits: Money;
  readonly residual: Money;
  readonly balanced: boolean;
  readonly byAccount: readonly AccountBalance[];
}

/** The daily proof that the books are internally consistent. */
export const trialBalance = (entries: readonly JournalEntry[], currency: string): TrialBalance => {
  let totalDebits = Money.zero(currency);
  let totalCredits = Money.zero(currency);
  for (const entry of entries) {
    for (const p of entry.postings) {
      if (p.amount.isPositive()) totalDebits = totalDebits.plus(p.amount);
      else totalCredits = totalCredits.plus(p.amount.abs());
    }
  }
  const residual = totalDebits.minus(totalCredits);
  return {
    totalDebits, totalCredits, residual,
    balanced: residual.isZero(),
    byAccount: [...computeBalances(entries, currency).values()],
  };
};

export interface ReconciliationBreak {
  readonly kind: 'unbalanced_entry' | 'trial_balance_residual' | 'facility_mismatch' | 'suspense_not_cleared' | 'duplicate_idempotency_key';
  readonly detail: string;
  readonly amount: Money | null;
  readonly reference: string | null;
}

/**
 * Daily reconciliation (PRD §22 "partner settlement reconciliation").
 * Compares the ledger's view of a customer's debt against the facility record
 * that the authorization path reads, and surfaces every disagreement.
 */
export const reconcile = (
  entries: readonly JournalEntry[],
  currency: string,
  facilities: readonly { customerId: string; principal: Money; interest: Money; fees: Money }[],
): ReconciliationBreak[] => {
  const breaks: ReconciliationBreak[] = [];

  const seenKeys = new Set<string>();
  for (const entry of entries) {
    if (seenKeys.has(entry.idempotencyKey)) {
      breaks.push({
        kind: 'duplicate_idempotency_key',
        detail: `idempotency key ${entry.idempotencyKey} posted more than once`,
        amount: null, reference: entry.entryId,
      });
    }
    seenKeys.add(entry.idempotencyKey);

    let residual = Money.zero(entry.currency);
    for (const p of entry.postings) residual = residual.plus(p.amount);
    if (!residual.isZero()) {
      breaks.push({
        kind: 'unbalanced_entry',
        detail: `entry ${entry.entryId} (${entry.kind}) does not balance`,
        amount: residual, reference: entry.entryId,
      });
    }
  }

  const tb = trialBalance(entries, currency);
  if (!tb.balanced) {
    breaks.push({
      kind: 'trial_balance_residual',
      detail: 'debits and credits do not net to zero across the ledger',
      amount: tb.residual, reference: null,
    });
  }

  const balances = computeBalances(entries, currency);
  for (const f of facilities) {
    const checks: [string, Money, Money][] = [
      ['principal', balanceOf(balances, ACCOUNTS.CUSTOMER_RECEIVABLE, f.customerId, currency), f.principal],
      ['interest', balanceOf(balances, ACCOUNTS.INTEREST_RECEIVABLE, f.customerId, currency), f.interest],
      ['fees', balanceOf(balances, ACCOUNTS.FEE_RECEIVABLE, f.customerId, currency), f.fees],
    ];
    for (const [label, ledgerValue, facilityValue] of checks) {
      const diff = ledgerValue.minus(facilityValue);
      if (!diff.isZero()) {
        breaks.push({
          kind: 'facility_mismatch',
          detail: `customer ${f.customerId}: ledger ${label} ${ledgerValue.toFixedString()} vs facility ${facilityValue.toFixedString()}`,
          amount: diff, reference: f.customerId,
        });
      }
    }
  }

  const suspense = balanceOf(balances, ACCOUNTS.SUSPENSE, null, currency);
  if (!suspense.isZero()) {
    breaks.push({
      kind: 'suspense_not_cleared',
      detail: 'suspense account carries a balance at end of day',
      amount: suspense, reference: null,
    });
  }

  return breaks;
};

/** Sum of a customer's receivable accounts — their total debt per the ledger. */
export const customerDebtFromLedger = (
  balances: ReadonlyMap<string, AccountBalance>, customerId: string, currency: string,
): Money =>
  balanceOf(balances, ACCOUNTS.CUSTOMER_RECEIVABLE, customerId, currency)
    .plus(balanceOf(balances, ACCOUNTS.INTEREST_RECEIVABLE, customerId, currency))
    .plus(balanceOf(balances, ACCOUNTS.FEE_RECEIVABLE, customerId, currency))
    .minus(balanceOf(balances, ACCOUNTS.CUSTOMER_CREDIT_BALANCE, customerId, currency).abs());

/** Revenue, cost and margin over a set of entries — feeds the unit-economics KPIs. */
export const incomeStatement = (entries: readonly JournalEntry[], currency: string) => {
  const b = computeBalances(entries, currency);
  const rev = (code: string) => balanceOf(b, code, null, currency).negated(); // credits are negative
  const exp = (code: string) => balanceOf(b, code, null, currency);

  const revenue = {
    interchange: rev(ACCOUNTS.INTERCHANGE_REVENUE),
    interest: rev(ACCOUNTS.INTEREST_REVENUE),
    fx: rev(ACCOUNTS.FX_REVENUE),
    membership: rev(ACCOUNTS.MEMBERSHIP_REVENUE),
  };
  const expenses = {
    rewards: exp(ACCOUNTS.REWARDS_EXPENSE),
    creditLoss: exp(ACCOUNTS.CREDIT_LOSS_EXPENSE),
    liquidationCost: exp(ACCOUNTS.LIQUIDATION_COST_EXPENSE),
    fraudLoss: exp(ACCOUNTS.FRAUD_LOSS_EXPENSE),
  };
  const totalRevenue = Object.values(revenue).reduce((a, m) => a.plus(m), Money.zero(currency));
  const totalExpense = Object.values(expenses).reduce((a, m) => a.plus(m), Money.zero(currency));
  const grossProfit = totalRevenue.minus(totalExpense);
  return {
    revenue, expenses, totalRevenue, totalExpense, grossProfit,
    grossMargin: totalRevenue.isPositive() ? grossProfit.amount.dividedBy(totalRevenue.amount) : D(0),
  };
};
