/**
 * Credit service: turns the pure credit engine into a persisted decision.
 */
import type pg from 'pg';
import {
  D, decideCredit, getPolicy, Money, pricedAprBps, totalExposure,
  type CollateralSummary, type CreditDecision, type CreditFacility, type Jurisdiction,
  type Tier, type UnderwritingInputs,
} from '@wealthcard/core';
import { money, query, queryOne, toNumeric, toNumericOrNull, type Db } from '../db.js';
import { notFound } from '../errors.js';
import { audit } from '../audit.js';

export interface CustomerRow {
  id: string;
  email: string;
  legal_name: string;
  jurisdiction: string;
  status: UnderwritingInputs['customerStatus'];
  tier: Tier;
  kyc_status: UnderwritingInputs['kycStatus'];
  sanctions_clear: boolean;
  pep_review_cleared: boolean;
  fraud_score: string;
  delinquencies_30d: number;
  on_time_rate: string | null;
  monthly_income: string | null;
  custody_account_id: string | null;
  created_at: Date;
}

export const loadCustomer = async (db: Db, customerId: string): Promise<CustomerRow> => {
  const row = await queryOne<CustomerRow>(db, 'SELECT * FROM customers WHERE id = $1', [customerId]);
  if (!row) throw notFound('Customer');
  return row;
};

export const loadFacility = async (
  db: Db, customerId: string,
): Promise<CreditFacility> => {
  const row = await queryOne<{
    id: string; customer_id: string; currency: string; credit_limit: string;
    principal_balance: string; interest_balance: string; fee_balance: string;
    holds_total: string; apr_bps: number; status: CreditFacility['status']; opened_at: Date;
  }>(db, 'SELECT * FROM credit_facilities WHERE customer_id = $1', [customerId]);
  if (!row) throw notFound('Credit facility');

  const currency = row.currency;
  return {
    facilityId: row.id,
    customerId: row.customer_id,
    currency,
    creditLimit: money(row.credit_limit, currency),
    principalBalance: money(row.principal_balance, currency),
    interestBalance: money(row.interest_balance, currency),
    feeBalance: money(row.fee_balance, currency),
    holdsTotal: money(row.holds_total, currency),
    aprBps: row.apr_bps,
    status: row.status,
    openedAt: row.opened_at,
  };
};

export const findFacility = async (db: Db, customerId: string): Promise<CreditFacility | null> => {
  const row = await queryOne<{ id: string }>(
    db, 'SELECT id FROM credit_facilities WHERE customer_id = $1', [customerId],
  );
  return row ? loadFacility(db, customerId) : null;
};

/** Months between two dates, used for the tenure term. */
const monthsBetween = (from: Date, to: Date): number =>
  Math.max(0, Math.floor((to.getTime() - from.getTime()) / (30.44 * 86_400_000)));

export const underwritingFor = (
  customer: CustomerRow, now: Date,
): UnderwritingInputs => ({
  kycStatus: customer.kyc_status,
  customerStatus: customer.status,
  jurisdiction: customer.jurisdiction as Jurisdiction,
  tier: customer.tier,
  sanctionsClear: customer.sanctions_clear,
  pepReviewCleared: customer.pep_review_cleared,
  tenureMonths: monthsBetween(customer.created_at, now),
  fraudScore: D(customer.fraud_score),
  delinquencies30d: customer.delinquencies_30d,
  onTimeRate: customer.on_time_rate === null ? null : D(customer.on_time_rate),
  monthlyIncome: customer.monthly_income === null ? null : money(customer.monthly_income),
  externalMonthlyDebtService: null,
});

export interface RepricingResult {
  readonly decision: CreditDecision;
  readonly facility: CreditFacility;
  readonly limitChanged: boolean;
}

/**
 * Re-underwrite a customer and persist the outcome.
 *
 * Called at origination, after collateral changes, and on every risk tick. The
 * decision row is always written even when the limit does not move, because
 * "we looked and nothing changed" is itself an auditable fact.
 */
export const repriceCredit = async (
  tx: pg.PoolClient,
  customer: CustomerRow,
  collateral: CollateralSummary,
  now: Date,
  actor: { type: 'customer' | 'operator' | 'system'; id: string },
): Promise<RepricingResult> => {
  const policy = getPolicy();
  const existing = await findFacility(tx, customer.id);
  const exposure = existing ? totalExposure(existing) : Money.zero(policy.facilityCurrency);

  const decision = decideCredit({
    customerId: customer.id,
    collateral,
    underwriting: underwritingFor(customer, now),
    existingExposure: exposure,
    previousLimit: existing?.creditLimit ?? null,
    policy,
    now,
  });

  await query(
    tx,
    `INSERT INTO credit_decisions
       (customer_id, approved, credit_limit, previous_limit, breakdown, decline_reasons,
        explanations, policy_version, decided_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      customer.id, decision.approved, toNumeric(decision.creditLimit),
      toNumericOrNull(decision.previousLimit),
      JSON.stringify({
        baseCollateralCapacity: decision.breakdown.baseCollateralCapacity.toFixedString(),
        advanceRate: decision.breakdown.advanceRate.toFixed(),
        portfolioRiskAdjustment: decision.breakdown.portfolioRiskAdjustment.toFixed(),
        liquidityAdjustment: decision.breakdown.liquidityAdjustment.toFixed(),
        concentrationAdjustment: decision.breakdown.concentrationAdjustment.toFixed(),
        customerAdjustment: decision.breakdown.customerAdjustment.toFixed(),
        tierCap: decision.breakdown.tierCap.toFixedString(),
        jurisdictionCap: decision.breakdown.jurisdictionCap.toFixedString(),
        existingExposure: decision.breakdown.existingExposure.toFixedString(),
        eligibleCollateralValue: collateral.eligibleCollateralValue.toFixedString(),
        totalMarketValue: collateral.totalMarketValue.toFixedString(),
      }),
      decision.declineReasons, decision.explanations, decision.policyVersion, now,
    ],
  );

  const aprBps = pricedAprBps(policy, customer.tier, collateral.weightedVolatility);

  // A facility exists from origination onward, even when the limit is zero:
  // the ledger needs somewhere to hang balances, and a declined applicant may
  // qualify later without a new account.
  if (!existing) {
    await query(
      tx,
      `INSERT INTO credit_facilities (customer_id, currency, credit_limit, apr_bps, status)
       VALUES ($1,$2,$3,$4,$5)`,
      [customer.id, policy.facilityCurrency, toNumeric(decision.creditLimit), aprBps,
       decision.approved ? 'active' : 'pending'],
    );
  } else {
    // An operations freeze outranks an engine decision: only a human clears it.
    const nextStatus = existing.status === 'frozen' || existing.status === 'closed' || existing.status === 'defaulted'
      ? existing.status
      : decision.approved ? 'active' : existing.status === 'active' ? 'restricted' : existing.status;

    await query(
      tx,
      `UPDATE credit_facilities
          SET credit_limit = $2, apr_bps = $3, status = $4, updated_at = now()
        WHERE customer_id = $1`,
      [customer.id, toNumeric(decision.creditLimit), aprBps, nextStatus],
    );
  }

  const facility = await loadFacility(tx, customer.id);
  const limitChanged = existing === null || !existing.creditLimit.eq(facility.creditLimit);

  if (limitChanged) {
    await audit(tx, {
      actorType: actor.type, actorId: actor.id,
      action: 'credit.limit_changed',
      entityType: 'credit_facility', entityId: facility.facilityId,
      before: existing ? { creditLimit: existing.creditLimit.toFixedString() } : null,
      after: {
        creditLimit: facility.creditLimit.toFixedString(),
        approved: decision.approved,
        declineReasons: decision.declineReasons,
      },
      policyVersion: decision.policyVersion,
    });
  }

  return { decision, facility, limitChanged };
};

export const latestDecision = async (
  db: Db, customerId: string,
): Promise<{
  approved: boolean; creditLimit: string; previousLimit: string | null;
  breakdown: Record<string, string>; declineReasons: string[]; explanations: string[];
  policyVersion: string; decidedAt: Date;
} | null> => {
  const row = await queryOne<{
    approved: boolean; credit_limit: string; previous_limit: string | null;
    breakdown: Record<string, string>; decline_reasons: string[]; explanations: string[];
    policy_version: string; decided_at: Date;
  }>(
    db,
    `SELECT * FROM credit_decisions WHERE customer_id = $1 ORDER BY decided_at DESC LIMIT 1`,
    [customerId],
  );
  if (!row) return null;
  return {
    approved: row.approved,
    creditLimit: money(row.credit_limit).toFixedString(),
    previousLimit: row.previous_limit ? money(row.previous_limit).toFixedString() : null,
    breakdown: row.breakdown,
    declineReasons: row.decline_reasons,
    explanations: row.explanations,
    policyVersion: row.policy_version,
    decidedAt: row.decided_at,
  };
};
