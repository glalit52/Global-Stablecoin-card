/**
 * Card authorization (PRD §13, §21 POST /card/authorize).
 *
 * The hot path. A card network gives us a few hundred milliseconds to answer,
 * so this function does no I/O at all: the caller assembles the context and
 * this decides. Every check appends to an ordered trace which becomes the
 * audit record and the evidence in a dispute.
 *
 * Checks run cheapest-first and short-circuit, but the trace always records
 * which check stopped the transaction and why.
 */
import { clamp, D, Decimal, Money, ONE, ZERO } from './money.js';
import { tierPolicy, type RiskPolicy } from './policy.js';
import { availableCredit } from './credit.js';
import { projectAfterSpend, stateForLtv } from './risk.js';
import { assessFraud, categoryForMcc, type FraudContext } from './fraud.js';
import type {
  AuthorizationCheck, AuthorizationDecision, AuthorizationRequest, Card,
  CreditFacility, DeclineCode, RiskSnapshot, Tier,
} from './types.js';

export interface AuthorizationContext {
  readonly card: Card;
  readonly facility: CreditFacility;
  readonly risk: RiskSnapshot;
  readonly tier: Tier;
  readonly fraud: FraudContext;
  /** FX rate from the merchant's currency into the billing currency. */
  readonly fxRate: Decimal | null;
  /** Spend already authorized today and this month, in billing currency. */
  readonly spentToday: Money;
  readonly spentThisMonth: Money;
  /** Set when the customer has completed step-up auth for this transaction. */
  readonly stepUpSatisfied: boolean;
  /** True when this requestId was already decided — replay protection. */
  readonly duplicateOf?: AuthorizationDecision;
  readonly policy: RiskPolicy;
  readonly now: Date;
}

interface Stop {
  readonly code: DeclineCode;
  readonly reason: string;
}

const check = (name: string, passed: boolean, detail: string): AuthorizationCheck =>
  ({ name, passed, detail });

/** Cards expire at the end of their expiry month. */
const isExpired = (card: Card, now: Date): boolean => {
  const endOfMonth = new Date(Date.UTC(card.expYear, card.expMonth, 1));
  return now >= endOfMonth;
};

export const authorize = (
  req: AuthorizationRequest, ctx: AuthorizationContext,
): AuthorizationDecision => {
  const started = Date.now();
  const { card, facility, policy, now } = ctx;
  const billingCurrency = facility.currency;
  const checks: AuthorizationCheck[] = [];
  let stop: Stop | null = null;

  const fail = (code: DeclineCode, reason: string): void => { if (!stop) stop = { code, reason }; };

  // Replaying a requestId must return the original answer, not re-run the
  // pipeline: the network retries, and a second run could decide differently
  // as prices move.
  if (ctx.duplicateOf) {
    return { ...ctx.duplicateOf, latencyMs: Date.now() - started };
  }

  // --- 1. Card state -------------------------------------------------------
  const cardUsable = card.status === 'active';
  checks.push(check('card_status', cardUsable, `Card status is ${card.status}`));
  if (!cardUsable) {
    fail(
      card.status === 'frozen' ? '62_restricted_card'
        : card.status === 'lost_stolen' ? '59_suspected_fraud'
        : '78_card_not_active',
      card.status === 'frozen' ? 'Card is frozen' : `Card is ${card.status.replace('_', ' ')}`,
    );
  }

  const expired = isExpired(card, now);
  checks.push(check('card_expiry', !expired, `Expires ${String(card.expMonth).padStart(2, '0')}/${card.expYear}`));
  if (expired) fail('54_expired_card', 'Card has expired');

  // --- 2. Facility state ---------------------------------------------------
  const facilityOpen = facility.status === 'active' || facility.status === 'restricted';
  checks.push(check('facility_status', facilityOpen, `Credit facility is ${facility.status}`));
  if (!facilityOpen) fail('62_restricted_card', `Credit facility is ${facility.status}`);

  // --- 3. Merchant and channel controls ------------------------------------
  const c = card.controls;
  const country = req.merchantCountry.toUpperCase();

  const mccAllowed = !c.blockedMccs.includes(req.mcc);
  checks.push(check('mcc_control', mccAllowed, `Merchant category ${req.mcc}`));
  if (!mccAllowed) fail('57_txn_not_permitted', 'This merchant category is blocked on your card');

  const countryAllowed =
    !c.blockedCountries.includes(country) &&
    (c.allowedCountries.length === 0 || c.allowedCountries.includes(country));
  checks.push(check('country_control', countryAllowed, `Merchant country ${country}`));
  if (!countryAllowed) fail('57_txn_not_permitted', `Transactions in ${country} are blocked on your card`);

  const channelAllowed =
    (req.entryMode !== 'atm' || c.atmEnabled) &&
    (req.entryMode !== 'ecommerce' || c.onlineEnabled) &&
    (req.entryMode !== 'contactless' || c.contactlessEnabled);
  checks.push(check('channel_control', channelAllowed, `Entry mode ${req.entryMode}`));
  if (!channelAllowed) fail('57_txn_not_permitted', `${req.entryMode} transactions are disabled on your card`);

  // --- 4. FX conversion ----------------------------------------------------
  // Done before the limit checks: a limit must be tested against what we will
  // actually post to the facility, not against the merchant's local number.
  const tp = tierPolicy(policy, ctx.tier);
  const sameCurrency = req.amount.currency === billingCurrency;
  let convertedAmount: Money;
  let fxFee = Money.zero(billingCurrency);
  let appliedRate: Decimal | null = null;

  if (sameCurrency) {
    convertedAmount = req.amount;
  } else if (ctx.fxRate && ctx.fxRate.gt(0)) {
    appliedRate = ctx.fxRate;
    convertedAmount = req.amount.convertTo(billingCurrency, ctx.fxRate).round();
    fxFee = convertedAmount.times(D(tp.fxMarkupBps).dividedBy(10_000)).round();
  } else {
    convertedAmount = Money.zero(billingCurrency);
    checks.push(check('fx_rate', false, `No rate available ${req.amount.currency} -> ${billingCurrency}`));
    fail('96_system_error', 'No exchange rate is available for this currency');
  }

  const billingAmount = convertedAmount.plus(fxFee);
  if (!sameCurrency && appliedRate) {
    checks.push(check('fx_conversion', true,
      `${req.amount.toDisplayString()} ${req.amount.currency} at ${appliedRate.toDecimalPlaces(6)} = ${convertedAmount.toDisplayString()} ${billingCurrency}, fee ${fxFee.toDisplayString()}`));
  }

  const international = country !== 'US';
  if (international && !c.internationalEnabled) {
    checks.push(check('international_control', false, 'International transactions disabled'));
    fail('57_txn_not_permitted', 'International transactions are disabled on your card');
  }

  // --- 5. Card-level velocity limits ---------------------------------------
  const withinPerTxn = !c.perTransactionLimit || billingAmount.lte(c.perTransactionLimit);
  checks.push(check('per_transaction_limit', withinPerTxn,
    c.perTransactionLimit ? `Limit ${c.perTransactionLimit.toDisplayString()}` : 'No per-transaction limit'));
  if (!withinPerTxn) fail('61_exceeds_limit', 'Transaction exceeds your per-transaction limit');

  const withinDaily = !c.dailyLimit || ctx.spentToday.plus(billingAmount).lte(c.dailyLimit);
  checks.push(check('daily_limit', withinDaily,
    c.dailyLimit ? `${ctx.spentToday.toDisplayString()} of ${c.dailyLimit.toDisplayString()} used today` : 'No daily limit'));
  if (!withinDaily) fail('65_exceeds_frequency', 'Transaction exceeds your daily spending limit');

  const withinMonthly = !c.monthlyLimit || ctx.spentThisMonth.plus(billingAmount).lte(c.monthlyLimit);
  checks.push(check('monthly_limit', withinMonthly,
    c.monthlyLimit ? `${ctx.spentThisMonth.toDisplayString()} of ${c.monthlyLimit.toDisplayString()} used this month` : 'No monthly limit'));
  if (!withinMonthly) fail('65_exceeds_frequency', 'Transaction exceeds your monthly spending limit');

  // --- 6. Fraud ------------------------------------------------------------
  const fraud = assessFraud(req, ctx.fraud);
  checks.push(check('fraud_score', !fraud.decline,
    `Score ${fraud.score.toDecimalPlaces(2)}${fraud.signals.length ? `: ${fraud.signals.map((s) => s.code).join(', ')}` : ''}`));
  if (fraud.decline) fail('59_suspected_fraud', 'Declined for suspected fraud — confirm the transaction in the app to retry');

  const stepUpOk = !fraud.requireStepUp || ctx.stepUpSatisfied;
  checks.push(check('step_up_authentication', stepUpOk,
    fraud.requireStepUp ? (ctx.stepUpSatisfied ? 'Step-up satisfied' : 'Step-up required and not satisfied') : 'Not required'));
  if (!stepUpOk) fail('59_suspected_fraud', 'Additional verification is required — approve this transaction in the app');

  // --- 7. Risk state -------------------------------------------------------
  // A restricted account may still service recurring commitments and
  // essentials; discretionary new spend is what gets cut off.
  const category = categoryForMcc(req.mcc);
  const essential = category === 'groceries' || category === 'utilities' || category === 'fuel_ev';
  const riskBlocks =
    ctx.risk.state === 'liquidation' ||
    ctx.risk.state === 'remediation' ||
    (ctx.risk.state === 'restricted' && !req.isRecurring && !essential);

  checks.push(check('risk_state', !riskBlocks,
    `Account risk state is ${ctx.risk.state}${ctx.risk.effectiveLtv ? ` at ${ctx.risk.effectiveLtv.times(100).toDecimalPlaces(1)}% LTV` : ''}`));
  if (riskBlocks) {
    fail('62_restricted_card',
      ctx.risk.state === 'restricted'
        ? 'New discretionary spending is paused while your collateral is under pressure'
        : 'Spending is paused until your collateral position is restored');
  }

  // --- 8. Available credit -------------------------------------------------
  // Checked before the LTV ceiling on purpose. A request above the limit is an
  // "insufficient funds" decline — the code the network and the customer both
  // expect — and answering "restricted card" instead would tell them their
  // account is in trouble when it is simply a purchase they cannot afford.
  const available = availableCredit(facility);
  const sufficient = billingAmount.lte(available);
  checks.push(check('available_credit', sufficient,
    `${available.toDisplayString()} ${billingCurrency} available, ${billingAmount.toDisplayString()} requested`));
  if (!sufficient) fail('51_insufficient_funds', 'Transaction exceeds your available credit');

  // --- 9. LTV ceiling ------------------------------------------------------
  // Independent of the contractual limit: even inside the limit we will not
  // lend past the spend-block line.
  const projected = projectAfterSpend(ctx.risk, billingAmount, policy);
  const blockLtv = D(policy.thresholds.spendBlockLtv);
  const ltvOk = projected.ltv === null ? !billingAmount.isPositive() : projected.ltv.lt(blockLtv);
  checks.push(check('projected_ltv', ltvOk,
    projected.ltv ? `Post-transaction LTV ${projected.ltv.times(100).toDecimalPlaces(1)}% against a ${blockLtv.times(100)}% ceiling` : 'No collateral'));
  if (!ltvOk) fail('62_restricted_card', 'This transaction would take your loan-to-value past the permitted ceiling');

  // --- Outcome -------------------------------------------------------------
  const approved = stop === null;
  const availableCreditAfter = approved ? available.minus(billingAmount) : available;

  return {
    requestId: req.requestId,
    approved,
    authorizationId: approved ? `auth_${req.requestId}` : null,
    billingAmount: approved ? billingAmount : Money.zero(billingCurrency),
    fxRate: appliedRate,
    fxFee: approved ? fxFee : Money.zero(billingCurrency),
    declineCode: stop ? (stop as Stop).code : null,
    declineReason: stop ? (stop as Stop).reason : null,
    checks,
    fraudScore: fraud.score,
    availableCreditAfter,
    decidedAt: now,
    latencyMs: Date.now() - started,
  };
};

/**
 * What a purchase of this size would do to the account, without committing
 * anything. Powers the "large purchase" journey in PRD §7 and the AI agent's
 * transaction-impact answer.
 */
export interface SpendPreview {
  readonly amount: Money;
  readonly affordable: boolean;
  readonly availableCreditAfter: Money;
  readonly utilizationAfter: Decimal | null;
  readonly ltvAfter: Decimal | null;
  readonly stateAfter: import('./types.js').RiskState;
  readonly healthPercentAfter: Decimal;
  readonly drawdownToleranceAfter: Decimal | null;
  readonly estimatedPoints: Decimal;
  readonly explanation: string;
}

export const previewSpend = (
  amount: Money, facility: CreditFacility, risk: RiskSnapshot,
  policy: RiskPolicy, estimatedPoints: Decimal,
): SpendPreview => {
  const available = availableCredit(facility);
  const affordable = amount.lte(available);
  const projected = projectAfterSpend(risk, amount, policy);
  const exposureAfter = facility.principalBalance.plus(facility.interestBalance)
    .plus(facility.feeBalance).plus(facility.holdsTotal).plus(amount);

  const utilizationAfter = facility.creditLimit.isPositive()
    ? exposureAfter.amount.dividedBy(facility.creditLimit.amount) : null;

  const drawdownToleranceAfter = risk.eligibleCollateralValue.isPositive() && exposureAfter.isPositive()
    ? clamp(
        ONE.minus(
          exposureAfter.amount.dividedBy(D(policy.thresholds.liquidationLtv))
            .dividedBy(risk.eligibleCollateralValue.amount),
        ), 0, 1,
      )
    : null;

  const explanation = !affordable
    ? `A ${amount.toDisplayString()} ${amount.currency} purchase is above your available credit of ${available.toDisplayString()}.`
    : `A ${amount.toDisplayString()} ${amount.currency} purchase would leave ${available.minus(amount).toDisplayString()} available` +
      (projected.ltv
        ? `, moving your loan-to-value to ${projected.ltv.times(100).toDecimalPlaces(1)}% and your account to ${projected.state}.`
        : '.') +
      (drawdownToleranceAfter
        ? ` Your collateral could then fall ${drawdownToleranceAfter.times(100).toDecimalPlaces(0)}% before we would need to act.`
        : '');

  return {
    amount, affordable,
    availableCreditAfter: available.minus(amount).clampPositive(),
    utilizationAfter,
    ltvAfter: projected.ltv,
    stateAfter: projected.state,
    healthPercentAfter: projected.healthPercent,
    drawdownToleranceAfter,
    estimatedPoints,
    explanation,
  };
};

/**
 * Largest purchase that stays inside both the credit limit and the policy's
 * spend-block LTV. This is the honest answer to "how much can I spend?" —
 * it is not simply the available credit.
 */
export const maxSafeSpend = (
  facility: CreditFacility, risk: RiskSnapshot, policy: RiskPolicy,
  target: 'watch' | 'block' = 'watch',
): Money => {
  const available = availableCredit(facility);
  if (!risk.eligibleCollateralValue.isPositive()) return Money.zero(facility.currency);

  const ceilingLtv = target === 'watch'
    ? D(policy.thresholds.watchLtv)
    : D(policy.thresholds.spendBlockLtv);

  const maxExposure = risk.eligibleCollateralValue.times(ceilingLtv);
  const currentExposure = risk.totalDebt.plus(facility.holdsTotal);
  const riskHeadroom = maxExposure.minus(currentExposure).clampPositive();

  return riskHeadroom.min(available).roundDown();
};

export { stateForLtv, ZERO };
