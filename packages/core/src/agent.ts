/**
 * AI Wealth & Credit Agent (PRD §16).
 *
 * The guardrail in §16.3 is "never fabricate balances or market data". We do
 * not try to achieve that by asking a model nicely. Instead:
 *
 *   1. The server computes a FactPack — every number the agent is allowed to
 *      say, each carrying its own value, timestamp and source.
 *   2. A deterministic explainer answers every supported intent from that pack
 *      alone. This is the production path and it needs no model at all.
 *   3. When a language model is configured it may only *rephrase* the pack.
 *      Its output then passes `groundingViolations`, which extracts every
 *      number in the response and rejects any that is not in the pack.
 *      A response that fails falls back to the deterministic text.
 *
 * The consequence is that the worst a misbehaving model can do is produce
 * prose that gets thrown away — it can never invent a balance.
 */
import { D, Decimal, formatInstant, Money, pct } from './money.js';
import type { RiskPolicy } from './policy.js';
import { availableCredit, totalDebt, utilization } from './credit.js';
import { collateralCallAmount, drawdownTolerance, repaymentToTarget, runAllStressScenarios } from './risk.js';
import { describeIneligibility } from './collateral.js';
import type {
  CollateralSummary, CreditDecision, CreditFacility, RiskSnapshot, Tier,
} from './types.js';

export type AgentIntent =
  | 'explain_limit'
  | 'why_changed'
  | 'collateral_health'
  | 'concentration_warning'
  | 'safe_spend'
  | 'transaction_impact'
  | 'market_change'
  | 'repayment_options'
  | 'stress_test'
  | 'rewards_summary'
  | 'unsupported';

/** One disclosable value: what it is, what it is worth, and when we knew it. */
export interface Fact {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly unit: 'money' | 'percent' | 'ratio' | 'count' | 'text' | 'date';
  readonly asOf: Date;
  readonly source: string;
}

export interface FactPack {
  readonly customerId: string;
  readonly currency: string;
  readonly facts: readonly Fact[];
  readonly policyVersion: string;
  readonly generatedAt: Date;
  /** True when some input was stale or disputed — the agent must say so. */
  readonly degraded: boolean;
}

export interface AgentAnswer {
  readonly intent: AgentIntent;
  readonly text: string;
  /** The subset of facts the answer actually relies on, for the "sources" UI. */
  readonly citedFacts: readonly Fact[];
  /** True when a model rephrased the deterministic text, false when it did not run. */
  readonly modelUsed: boolean;
  /** Set when a model's draft was rejected by the grounding check. */
  readonly groundingRejected: boolean;
  readonly disclaimers: readonly string[];
  readonly policyVersion: string;
  readonly generatedAt: Date;
}

const fact = (
  key: string, label: string, value: string,
  unit: Fact['unit'], asOf: Date, source: string,
): Fact => ({ key, label, value, unit, asOf, source });

export interface FactPackInputs {
  readonly facility: CreditFacility;
  readonly risk: RiskSnapshot;
  readonly collateral: CollateralSummary;
  readonly creditDecision: CreditDecision | null;
  readonly previousRisk: RiskSnapshot | null;
  readonly tier: Tier;
  readonly pointsBalance: Decimal;
  /**
   * Collateral as it stood when `creditDecision` was made. The decision's
   * stored explanations quote these figures, and prices move between then and
   * now, so they have to be disclosable facts in their own right or the agent
   * ends up stating a number with no source attached.
   */
  readonly decisionCollateral?: {
    readonly eligibleCollateralValue: string;
    readonly totalMarketValue: string;
  } | null;
  readonly policy: RiskPolicy;
  readonly now: Date;
}

/**
 * Assemble everything the agent is permitted to state. Nothing outside this
 * pack may appear in an answer.
 */
export const buildFactPack = (input: FactPackInputs): FactPack => {
  const { facility, risk, collateral, policy, now } = input;
  const currency = facility.currency;
  const facts: Fact[] = [];

  const ledgerSource = 'credit_ledger';
  const riskSource = `risk_engine@${policy.version}`;
  const collateralSource = `collateral_engine@${policy.version}`;

  facts.push(
    fact('credit_limit', 'Credit limit', facility.creditLimit.toFixedString(), 'money', risk.computedAt, ledgerSource),
    fact('current_balance', 'Current balance', totalDebt(facility).toFixedString(), 'money', risk.computedAt, ledgerSource),
    fact('available_credit', 'Available credit', availableCredit(facility).toFixedString(), 'money', risk.computedAt, ledgerSource),
    fact('authorization_holds', 'Pending authorizations', facility.holdsTotal.toFixedString(), 'money', risk.computedAt, ledgerSource),
    fact('apr', 'Annual percentage rate', D(facility.aprBps).dividedBy(100).toFixed(2), 'percent', facility.openedAt, ledgerSource),
  );

  const util = utilization(facility);
  if (util) facts.push(fact('utilization', 'Credit utilization', util.times(100).toDecimalPlaces(1).toFixed(1), 'percent', risk.computedAt, ledgerSource));

  facts.push(
    fact('total_wealth', 'Total connected wealth', collateral.totalMarketValue.toFixedString(), 'money', collateral.computedAt, collateralSource),
    fact('eligible_collateral', 'Eligible collateral value', collateral.eligibleCollateralValue.toFixedString(), 'money', collateral.computedAt, collateralSource),
    fact('top_concentration', 'Largest single position share', collateral.topConcentration.times(100).toDecimalPlaces(1).toFixed(1), 'percent', collateral.computedAt, collateralSource),
    fact('portfolio_health', 'Portfolio health', risk.healthPercent.toFixed(1), 'percent', risk.computedAt, riskSource),
    fact('risk_state', 'Account risk state', risk.state, 'text', risk.computedAt, riskSource),
    fact('safe_spend', 'Spending capacity before the watch threshold', risk.safeSpendCapacity.toFixedString(), 'money', risk.computedAt, riskSource),
    fact('withdrawable_collateral', 'Collateral available to release', risk.withdrawableCollateral.toFixedString(), 'money', risk.computedAt, riskSource),
  );

  if (risk.effectiveLtv) {
    facts.push(fact('effective_ltv', 'Loan-to-value against eligible collateral', risk.effectiveLtv.times(100).toDecimalPlaces(1).toFixed(1), 'percent', risk.computedAt, riskSource));
  }
  if (risk.grossLtv) {
    facts.push(fact('gross_ltv', 'Loan-to-value against market value', risk.grossLtv.times(100).toDecimalPlaces(1).toFixed(1), 'percent', risk.computedAt, riskSource));
  }

  const tolerance = drawdownTolerance(risk, policy);
  if (tolerance) {
    facts.push(fact('drawdown_tolerance', 'Collateral fall absorbable before action', tolerance.times(100).toDecimalPlaces(0).toFixed(0), 'percent', risk.computedAt, riskSource));
  }

  // Thresholds are facts too — the customer is entitled to know the lines.
  facts.push(
    fact('watch_threshold', 'Watch threshold', D(policy.thresholds.watchLtv).times(100).toFixed(0), 'percent', now, `policy@${policy.version}`),
    fact('remediation_threshold', 'Margin call threshold', D(policy.thresholds.remediationLtv).times(100).toFixed(0), 'percent', now, `policy@${policy.version}`),
    fact('liquidation_threshold', 'Liquidation threshold', D(policy.thresholds.liquidationLtv).times(100).toFixed(0), 'percent', now, `policy@${policy.version}`),
    fact('advance_rate', 'Advance rate on eligible collateral', D(policy.thresholds.maxOriginationLtv).times(100).toFixed(0), 'percent', now, `policy@${policy.version}`),
  );

  // Per-position facts, so the agent can name the asset that is moving.
  for (const p of collateral.positions) {
    facts.push(fact(
      `position_${p.symbol}_value`, `${p.symbol} market value`,
      p.marketValue.toFixedString(), 'money', p.priceAsOf, `price_oracle:${p.symbol}`,
    ));
    if (p.eligible) {
      facts.push(
        fact(`position_${p.symbol}_eligible`, `${p.symbol} eligible collateral value`, p.eligibleValue.toFixedString(), 'money', p.priceAsOf, collateralSource),
        fact(`position_${p.symbol}_haircut`, `${p.symbol} haircut`, p.haircut.times(100).toDecimalPlaces(1).toFixed(1), 'percent', collateral.computedAt, collateralSource),
        fact(`position_${p.symbol}_share`, `${p.symbol} share of collateral`, p.concentration.times(100).toDecimalPlaces(1).toFixed(1), 'percent', collateral.computedAt, collateralSource),
      );
    }
  }

  if (input.previousRisk) {
    facts.push(
      fact('previous_eligible_collateral', 'Previous eligible collateral value', input.previousRisk.eligibleCollateralValue.toFixedString(), 'money', input.previousRisk.computedAt, collateralSource),
      fact('previous_health', 'Previous portfolio health', input.previousRisk.healthPercent.toFixed(1), 'percent', input.previousRisk.computedAt, riskSource),
    );
  }

  if (input.creditDecision) {
    const b = input.creditDecision.breakdown;
    facts.push(
      fact('base_collateral_capacity', 'Base capacity from collateral', b.baseCollateralCapacity.toFixedString(), 'money', input.creditDecision.decidedAt, `credit_engine@${policy.version}`),
      fact('portfolio_risk_adjustment', 'Portfolio risk adjustment', b.portfolioRiskAdjustment.toDecimalPlaces(3).toFixed(3), 'ratio', input.creditDecision.decidedAt, `credit_engine@${policy.version}`),
      fact('liquidity_adjustment', 'Liquidity adjustment', b.liquidityAdjustment.toDecimalPlaces(3).toFixed(3), 'ratio', input.creditDecision.decidedAt, `credit_engine@${policy.version}`),
      fact('concentration_adjustment', 'Concentration adjustment', b.concentrationAdjustment.toDecimalPlaces(3).toFixed(3), 'ratio', input.creditDecision.decidedAt, `credit_engine@${policy.version}`),
      fact('customer_adjustment', 'Account history adjustment', b.customerAdjustment.toDecimalPlaces(3).toFixed(3), 'ratio', input.creditDecision.decidedAt, `credit_engine@${policy.version}`),
    );
    if (input.creditDecision.previousLimit) {
      facts.push(fact('previous_credit_limit', 'Previous credit limit', input.creditDecision.previousLimit.toFixedString(), 'money', input.creditDecision.decidedAt, ledgerSource));
    }
    if (input.decisionCollateral) {
      facts.push(
        fact('decision_eligible_collateral', 'Eligible collateral at the time of the decision',
          input.decisionCollateral.eligibleCollateralValue, 'money',
          input.creditDecision.decidedAt, collateralSource),
        fact('decision_total_market_value', 'Connected wealth at the time of the decision',
          input.decisionCollateral.totalMarketValue, 'money',
          input.creditDecision.decidedAt, collateralSource),
      );
    }
  }

  facts.push(
    fact('rewards_points', 'Rewards points balance', input.pointsBalance.toFixed(0), 'count', now, 'rewards_ledger'),
    fact('tier', 'Membership tier', input.tier, 'text', now, 'membership'),
  );

  return {
    customerId: facility.customerId,
    currency,
    facts,
    policyVersion: policy.version,
    generatedAt: now,
    degraded: risk.degraded || collateral.degraded,
  };
};

export const findFact = (pack: FactPack, key: string): Fact | undefined =>
  pack.facts.find((f) => f.key === key);

const pick = (pack: FactPack, ...keys: string[]): Fact[] =>
  keys.map((k) => findFact(pack, k)).filter((f): f is Fact => f !== undefined);

// ---------------------------------------------------------------------------
// Intent classification
// ---------------------------------------------------------------------------

/**
 * Ordered most-specific first: the first pattern to match wins, so a broad
 * pattern placed early would swallow the narrow questions behind it.
 * A bare "how much" is deliberately not a safe-spend trigger, because
 * "how much do I owe" is a repayment question.
 */
const INTENT_PATTERNS: readonly [AgentIntent, RegExp][] = [
  ['why_changed', /\b(why|what).{0,30}\b(chang|drop|fall|fell|decreas|reduc|lower|went down|cut)/i],
  ['transaction_impact', /\b(if i (spend|buy|charge)|impact of|what happens if)/i],
  ['safe_spend', /\b(how much can i (safely )?(spend|afford|charge|put)|safe(ly)? spend|spending power|how much.{0,20}(available|left to spend))/i],
  ['stress_test', /\b(stress|what if.{0,20}(fall|drop|crash|goes? down)|scenario|downside)/i],
  ['concentration_warning', /\b(concentrat|diversif|too much|all in|single asset)/i],
  ['repayment_options', /\b(repay|pay(ment|ing|off)?|owe|balance due|minimum)/i],
  ['rewards_summary', /\b(point|reward|cashback|cash back|lounge|benefit|perk)/i],
  ['collateral_health', /\b(health|collateral|ltv|loan.?to.?value|margin|liquidat)/i],
  ['market_change', /\b(market|price|btc|bitcoin|crash|rally|volatil)/i],
  ['explain_limit', /\b(limit|credit line|how much credit|approved for|capacity)/i],
];

export const classifyIntent = (question: string): AgentIntent => {
  for (const [intent, pattern] of INTENT_PATTERNS) {
    if (pattern.test(question)) return intent;
  }
  return 'unsupported';
};

// ---------------------------------------------------------------------------
// Deterministic explainer — the production answer path
// ---------------------------------------------------------------------------

export interface ExplainInputs {
  readonly pack: FactPack;
  readonly facility: CreditFacility;
  readonly risk: RiskSnapshot;
  readonly collateral: CollateralSummary;
  readonly creditDecision: CreditDecision | null;
  readonly previousRisk: RiskSnapshot | null;
  readonly policy: RiskPolicy;
  /** Amount referenced by a transaction-impact question, when we parsed one. */
  readonly amount?: Money;
}

const asOfLine = (facts: readonly Fact[]): string => {
  if (facts.length === 0) return '';
  const newest = facts.reduce((a, f) => (f.asOf > a ? f.asOf : a), facts[0]!.asOf);
  return `Values as of ${formatInstant(newest)}.`;
};

export const explain = (intent: AgentIntent, input: ExplainInputs): AgentAnswer => {
  const { pack, facility, risk, collateral, policy } = input;
  const currency = pack.currency;
  const disclaimers: string[] = [];
  let text: string;
  let cited: Fact[];

  if (pack.degraded) {
    disclaimers.push('Some pricing or verification data is currently degraded, so these figures are deliberately conservative and may change when data recovers.');
  }

  switch (intent) {
    case 'explain_limit': {
      cited = pick(pack, 'credit_limit', 'eligible_collateral', 'advance_rate', 'base_collateral_capacity',
        'portfolio_risk_adjustment', 'liquidity_adjustment', 'concentration_adjustment', 'customer_adjustment',
        'decision_eligible_collateral', 'decision_total_market_value', 'tier', 'top_concentration');

      if (input.creditDecision) {
        // The stored decision already opens with the collateral-and-advance-rate
        // sentence. Generating our own version of it as well would state the
        // same quantity twice with two slightly different values, because
        // prices move between the decision and this request — which reads as
        // an inconsistency even though both figures are true as of their own
        // timestamps.
        const decidedAt = formatInstant(input.creditDecision.decidedAt);
        const collateralNow = collateral.eligibleCollateralValue;
        const collateralThen = input.creditDecision.breakdown.baseCollateralCapacity
          .dividedBy(input.creditDecision.breakdown.advanceRate);

        const parts = [
          `Your credit limit is ${facility.creditLimit.toDisplayString()} ${currency}, set on ${decidedAt}.`,
          ...input.creditDecision.explanations,
        ];

        // Only mention the live figure when it has actually moved enough to
        // matter, and say plainly that it is the newer of the two.
        const drift = collateralNow.minus(collateralThen).abs();
        if (collateralThen.isPositive() && drift.amount.dividedBy(collateralThen.amount).gt(D('0.01'))) {
          parts.push(
            `Since then your eligible collateral has moved to ${collateralNow.toDisplayString()} ${currency}; your limit is reviewed continuously and will follow it.`,
          );
        }
        text = parts.join(' ');
      } else {
        text = `Your credit limit is ${facility.creditLimit.toDisplayString()} ${currency}. It starts from ${collateral.eligibleCollateralValue.toDisplayString()} ${currency} of eligible collateral — your holdings after each asset's haircut — and applies a ${pct(D(policy.thresholds.maxOriginationLtv), 0)} advance rate.`;
      }
      break;
    }

    case 'why_changed': {
      cited = pick(pack, 'eligible_collateral', 'previous_eligible_collateral', 'credit_limit',
        'previous_credit_limit', 'portfolio_health', 'previous_health');
      if (!input.previousRisk) {
        text = `Your credit limit is ${facility.creditLimit.toDisplayString()} ${currency}, supported by ${collateral.eligibleCollateralValue.toDisplayString()} ${currency} of eligible collateral. I do not have an earlier snapshot to compare against, so I cannot attribute a change yet.`;
        break;
      }
      const prev = input.previousRisk.eligibleCollateralValue;
      const now = collateral.eligibleCollateralValue;
      const delta = now.minus(prev);
      const direction = delta.isNegative() ? 'fell' : delta.isPositive() ? 'rose' : 'was unchanged';

      const movers = collateral.positions
        .filter((p) => p.eligible)
        .sort((a, b) => b.eligibleValue.amount.comparedTo(a.eligibleValue.amount))
        .slice(0, 2)
        .map((p) => `${p.symbol} at ${p.marketValue.toDisplayString()} ${currency} (${pct(p.haircut)} haircut)`);

      text = `Your eligible collateral ${direction} from ${prev.toDisplayString()} to ${now.toDisplayString()} ${currency}, a change of ${delta.toDisplayString()}. Portfolio health moved from ${input.previousRisk.healthPercent.toFixed(1)}% to ${risk.healthPercent.toFixed(1)}%.` +
        (movers.length ? ` The largest contributors are ${movers.join(' and ')}.` : '') +
        ` Your credit limit is ${facility.creditLimit.toDisplayString()} ${currency}.`;
      break;
    }

    case 'collateral_health': {
      cited = pick(pack, 'portfolio_health', 'effective_ltv', 'eligible_collateral', 'current_balance',
        'drawdown_tolerance', 'liquidation_threshold', 'risk_state');
      const tolerance = drawdownTolerance(risk, policy);
      text = `Your portfolio health is ${risk.healthPercent.toFixed(1)}% and your account is ${risk.state}.` +
        (risk.effectiveLtv
          ? ` You are borrowing ${totalDebt(facility).toDisplayString()} ${currency} against ${collateral.eligibleCollateralValue.toDisplayString()} ${currency} of eligible collateral, a loan-to-value of ${pct(risk.effectiveLtv)}, against a ${pct(D(policy.thresholds.liquidationLtv), 0)} liquidation threshold.`
          : ` You have no balance drawn against ${collateral.eligibleCollateralValue.toDisplayString()} ${currency} of eligible collateral.`) +
        (tolerance ? ` Your collateral could fall ${pct(tolerance, 0)} before we would need to act.` : '');

      const ineligible = collateral.positions.filter((p) => !p.eligible && p.marketValue.isPositive());
      if (ineligible.length > 0) {
        const reasons = ineligible.slice(0, 3).map(
          (p) => `${p.symbol}: ${p.ineligibilityReasons.map(describeIneligibility).join('; ')}`,
        );
        text += ` Some holdings are not counted as collateral — ${reasons.join(' / ')}.`;
      }
      break;
    }

    case 'concentration_warning': {
      cited = pick(pack, 'top_concentration', 'concentration_adjustment', 'eligible_collateral');
      const top = collateral.positions
        .filter((p) => p.eligible)
        .sort((a, b) => b.concentration.comparedTo(a.concentration))[0];
      if (!top) {
        text = 'You have no eligible collateral positions, so there is no concentration to report.';
        break;
      }
      const concentrated = collateral.topConcentration.gt(D('0.5'));
      text = `${top.symbol} is ${pct(top.concentration)} of your eligible collateral.` +
        (concentrated
          ? ` Because more than half your collateral sits in one asset, your borrowing capacity carries a concentration reduction${input.creditDecision ? ` of ${pct(D(1).minus(input.creditDecision.breakdown.concentrationAdjustment))}` : ''}. Adding a different eligible asset would lift capacity without adding collateral value.`
          : ' That is within the level where concentration reduces your borrowing capacity.');
      break;
    }

    case 'safe_spend': {
      cited = pick(pack, 'safe_spend', 'available_credit', 'watch_threshold', 'credit_limit', 'effective_ltv');
      const available = availableCredit(facility);
      text = `You can spend ${risk.safeSpendCapacity.toDisplayString()} ${currency} while staying comfortably inside your risk thresholds. Your contractual available credit is ${available.toDisplayString()} ${currency}.` +
        (risk.safeSpendCapacity.lt(available)
          ? ` The lower figure is the one I would use: spending beyond it would take your loan-to-value past ${pct(D(policy.thresholds.watchLtv), 0)}, where we start monitoring the account more closely.`
          : '');
      break;
    }

    case 'transaction_impact': {
      cited = pick(pack, 'available_credit', 'effective_ltv', 'portfolio_health', 'credit_limit');
      if (!input.amount) {
        text = `Tell me an amount and I will show you exactly what it does to your balance, loan-to-value and health. Right now you have ${availableCredit(facility).toDisplayString()} ${currency} available.`;
        break;
      }
      const after = input.amount.plus(totalDebt(facility));
      const ltvAfter = collateral.eligibleCollateralValue.isPositive()
        ? after.amount.dividedBy(collateral.eligibleCollateralValue.amount) : null;
      text = `Spending ${input.amount.toDisplayString()} ${currency} would take your balance to ${after.toDisplayString()} ${currency} and leave ${availableCredit(facility).minus(input.amount).clampPositive().toDisplayString()} ${currency} available.` +
        (ltvAfter ? ` Your loan-to-value would move from ${risk.effectiveLtv ? pct(risk.effectiveLtv) : '0%'} to ${pct(ltvAfter)}.` : '');
      break;
    }

    case 'market_change': {
      cited = pick(pack, 'eligible_collateral', 'portfolio_health', 'drawdown_tolerance', 'effective_ltv');
      const positions = collateral.positions
        .filter((p) => p.marketValue.isPositive())
        .map((p) => `${p.symbol} at ${p.marketValue.toDisplayString()} ${currency} (priced ${formatInstant(p.priceAsOf)})`);
      const tolerance = drawdownTolerance(risk, policy);
      text = `Your collateral currently marks at ${collateral.totalMarketValue.toDisplayString()} ${currency}: ${positions.join(', ')}. After haircuts that supports ${collateral.eligibleCollateralValue.toDisplayString()} ${currency} of eligible collateral and a health of ${risk.healthPercent.toFixed(1)}%.` +
        (tolerance ? ` A further ${pct(tolerance, 0)} decline would bring you to the liquidation threshold.` : '');
      break;
    }

    case 'repayment_options': {
      cited = pick(pack, 'current_balance', 'apr', 'credit_limit', 'available_credit');
      const debt = totalDebt(facility);
      const toTarget = repaymentToTarget(risk, policy);
      text = debt.isPositive()
        ? `You owe ${debt.toDisplayString()} ${currency} at ${D(facility.aprBps).dividedBy(100).toFixed(2)}% APR. Repaying restores your available credit immediately.` +
          (toTarget.isPositive()
            ? ` A payment of ${toTarget.toDisplayString()} ${currency} would bring your loan-to-value back to the ${pct(D(policy.thresholds.liquidationTargetLtv), 0)} target.`
            : ' Your loan-to-value is already inside the target range, so there is no required payment beyond your statement minimum.')
        : `You have no balance outstanding. Your full credit limit of ${facility.creditLimit.toDisplayString()} ${currency} is available.`;
      break;
    }

    case 'stress_test': {
      cited = pick(pack, 'eligible_collateral', 'current_balance', 'effective_ltv', 'liquidation_threshold');
      const results = runAllStressScenarios(risk, collateral, policy);
      const lines = results.map((r) =>
        `${r.scenario.label}: collateral ${r.eligibleCollateralValue.toDisplayString()} ${currency}, ${r.effectiveLtv ? `LTV ${pct(r.effectiveLtv)}` : 'no LTV'}, account would be ${r.state}${r.collateralShortfall.isPositive() ? `, shortfall ${r.collateralShortfall.toDisplayString()}` : ''}`,
      );
      const failing = results.filter((r) => !r.survives);
      text = `Against your current balance of ${totalDebt(facility).toDisplayString()} ${currency}: ${lines.join('. ')}.` +
        (failing.length === 0
          ? ' Every modelled scenario leaves you inside your thresholds.'
          : ` ${failing.length} of ${results.length} scenarios would require action.`);
      break;
    }

    case 'rewards_summary': {
      cited = pick(pack, 'rewards_points', 'tier');
      const points = findFact(pack, 'rewards_points');
      text = `You are on the ${input.pack.facts.find((f) => f.key === 'tier')?.value ?? 'current'} tier with ${points?.value ?? '0'} points.`;
      break;
    }

    case 'unsupported':
    default: {
      cited = pick(pack, 'credit_limit', 'available_credit', 'portfolio_health', 'risk_state');
      text = `I can explain your credit limit, why it changed, your collateral health and concentration, how much you can safely spend, the impact of a specific purchase, repayment options and downside scenarios. Right now your limit is ${facility.creditLimit.toDisplayString()} ${currency} with ${availableCredit(facility).toDisplayString()} ${currency} available and health at ${risk.healthPercent.toFixed(1)}%.`;
      break;
    }
  }

  const asOf = asOfLine(cited);
  if (asOf) disclaimers.push(asOf);
  disclaimers.push('This is information about your account, not financial advice.');

  return {
    intent,
    text,
    citedFacts: cited,
    modelUsed: false,
    groundingRejected: false,
    disclaimers,
    policyVersion: pack.policyVersion,
    generatedAt: pack.generatedAt,
  };
};

// ---------------------------------------------------------------------------
// Grounding check — the gate every model-written sentence must pass
// ---------------------------------------------------------------------------

/**
 * Timestamps are provenance, not financial claims, so their digits are removed
 * before numbers are extracted. Otherwise "as of 19 Sep 2026" would fail the
 * grounding check on the year — which is true, disclosed, and not a value the
 * customer could act on.
 */
const TIMESTAMP_PATTERNS: readonly RegExp[] = [
  /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g,   // ISO 8601
  /\d{1,2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2} UTC/g,          // formatInstant
  /\d{1,2}\/\d{1,2}\/\d{4}/g,                              // 19/09/2026
];

export const stripTimestamps = (text: string): string =>
  TIMESTAMP_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, ' '), text);

/** Pull every number out of a piece of prose, normalised for comparison. */
export const extractNumbers = (text: string): string[] => {
  const matches = stripTimestamps(text).match(/-?\$?\d[\d,]*(?:\.\d+)?%?/g) ?? [];
  return matches.map((m) => m.replace(/[$,%]/g, '').replace(/,/g, ''));
};

const normalizeNumber = (raw: string): string | null => {
  const cleaned = raw.replace(/[^0-9.\-]/g, '');
  // Text facts such as "healthy" or "PRIVATE" clean down to an empty string,
  // and Decimal throws on those rather than returning NaN.
  if (!/^-?\d*\.?\d+$/.test(cleaned)) return null;
  try {
    const n = D(cleaned);
    return n.isFinite() ? n.toDecimalPlaces(2).toFixed() : null;
  } catch {
    return null;
  }
};

export interface GroundingResult {
  readonly grounded: boolean;
  readonly violations: readonly string[];
}

/**
 * Every number in `text` must appear in the fact pack.
 *
 * Small integers (0-31) are allowed through: they are overwhelmingly counts,
 * ordinals and dates rather than financial claims, and rejecting them would
 * make the model unable to write a normal sentence. Anything that could be a
 * balance, a rate or a percentage must be backed by a fact.
 */
export const groundingViolations = (text: string, pack: FactPack): GroundingResult => {
  const allowed = new Set<string>();
  for (const f of pack.facts) {
    const norm = normalizeNumber(f.value);
    if (norm) {
      allowed.add(norm);
      // Percentages are routinely written both as "12.3" and "12".
      allowed.add(D(norm).toDecimalPlaces(0).toFixed());
      allowed.add(D(norm).toDecimalPlaces(1).toFixed());
    }
  }

  const violations: string[] = [];
  for (const raw of extractNumbers(text)) {
    const norm = normalizeNumber(raw);
    if (norm === null) continue;
    const asNumber = Number(norm);
    if (Number.isInteger(asNumber) && Math.abs(asNumber) <= 31) continue;
    if (allowed.has(norm)) continue;
    if (allowed.has(D(norm).toDecimalPlaces(0).toFixed())) continue;
    if (allowed.has(D(norm).toDecimalPlaces(1).toFixed())) continue;
    violations.push(raw);
  }

  return { grounded: violations.length === 0, violations };
};

/** System prompt for the optional rephrasing model. */
export const buildModelPrompt = (pack: FactPack, question: string, deterministic: string): string => {
  const factLines = pack.facts.map(
    (f) => `- ${f.key} | ${f.label}: ${f.value}${f.unit === 'percent' ? '%' : f.unit === 'money' ? ` ${pack.currency}` : ''} (as of ${f.asOf.toISOString()}, source ${f.source})`,
  ).join('\n');

  return [
    'You are the Global Wealth Card account assistant.',
    '',
    'ABSOLUTE RULES:',
    '1. You may only state numbers that appear in the FACTS block below. Copy them exactly.',
    '2. Never estimate, extrapolate, round differently, or compute a new number.',
    '3. Never give investment advice or predict a price.',
    '4. If the question cannot be answered from the FACTS, say so plainly.',
    '5. Keep the answer under 120 words, warm and direct.',
    '',
    'FACTS:',
    factLines,
    '',
    `CUSTOMER QUESTION: ${question}`,
    '',
    'A deterministic answer has already been prepared from the same facts:',
    deterministic,
    '',
    'Rewrite it to address the question more directly. Change only the wording, never the numbers.',
  ].join('\n');
};
