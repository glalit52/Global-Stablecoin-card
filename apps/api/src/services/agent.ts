/**
 * AI Wealth & Credit Agent service (PRD §16).
 *
 * The grounding contract, restated because it is the whole design:
 *
 *   The server computes every number the agent may say. A deterministic
 *   explainer answers from those facts alone, and that is the production path.
 *   If a language model is configured it may only rephrase, and its draft is
 *   checked number-by-number against the fact pack before anyone sees it. A
 *   draft that fails is discarded and the deterministic answer ships instead.
 *
 * So a model outage, a hallucination, or a prompt injection in a merchant name
 * all have the same blast radius: slightly less fluent prose.
 */
import {
  buildFactPack, buildModelPrompt, classifyIntent, D, Decimal, explain, getPolicy,
  groundingViolations, Money, pointsBalance, type AgentAnswer, type AgentIntent,
  type CollateralSummary, type CreditDecision, type CreditFacility, type FactPack,
  type RiskSnapshot,
} from '@wealthcard/core';
import { query, type Db } from '../db.js';
import type { AppContext } from '../context.js';
import type { CustomerRow } from './credit.js';
import { latestDecision } from './credit.js';
import { previousSnapshot } from './risk.js';
import { loadRewardEntries } from './rewards.js';

/** Pull an amount out of a question like "what if I spend $25,000 on a watch". */
export const parseAmount = (question: string, currency: string): Money | null => {
  const match = question.match(/(?:[$£€]\s?)?(\d[\d,]*(?:\.\d{1,2})?)\s?(k|m)?\b/i);
  if (!match) return null;
  const base = match[1]!.replace(/,/g, '');
  const suffix = match[2]?.toLowerCase();
  const multiplier = suffix === 'k' ? 1_000 : suffix === 'm' ? 1_000_000 : 1;
  const value = Number(base) * multiplier;
  // Below this it is far more likely a date, a percentage or a count than an
  // amount the customer wants modelled.
  if (!Number.isFinite(value) || value < 50) return null;
  return Money.of(String(value), currency);
};

export interface AgentContext {
  readonly customer: CustomerRow;
  readonly facility: CreditFacility;
  readonly risk: RiskSnapshot;
  readonly collateral: CollateralSummary;
}

/**
 * Rehydrate a stored credit decision into the shape the fact-pack builder
 * expects. The breakdown was persisted as JSON strings, and every one of them
 * has to come back as an exact Decimal rather than a float.
 */
const rehydrateDecision = (
  customerId: string,
  currency: string,
  stored: NonNullable<Awaited<ReturnType<typeof latestDecision>>>,
): CreditDecision => {
  const num = (key: string, fallback = '0'): Decimal => D(stored.breakdown[key] ?? fallback);
  const amount = (key: string): Money => Money.of(stored.breakdown[key] ?? '0', currency);
  return {
    customerId,
    currency,
    approved: stored.approved,
    creditLimit: Money.of(stored.creditLimit, currency),
    previousLimit: stored.previousLimit ? Money.of(stored.previousLimit, currency) : null,
    breakdown: {
      baseCollateralCapacity: amount('baseCollateralCapacity'),
      steppedCapacity: amount('steppedCapacity'),
      advanceRate: num('advanceRate'),
      portfolioRiskAdjustment: num('portfolioRiskAdjustment', '1'),
      liquidityAdjustment: num('liquidityAdjustment', '1'),
      concentrationAdjustment: num('concentrationAdjustment', '1'),
      customerAdjustment: num('customerAdjustment', '1'),
      tierCap: amount('tierCap'),
      jurisdictionCap: amount('jurisdictionCap'),
      existingExposure: amount('existingExposure'),
    },
    declineReasons: stored.declineReasons,
    explanations: stored.explanations,
    policyVersion: stored.policyVersion,
    decidedAt: stored.decidedAt,
  };
};

export const buildPack = async (
  ctx: AppContext, db: Db, c: AgentContext,
): Promise<FactPack> => {
  const policy = getPolicy();
  const stored = await latestDecision(db, c.customer.id);
  const rewards = pointsBalance(await loadRewardEntries(db, c.customer.id));

  return buildFactPack({
    facility: c.facility,
    risk: c.risk,
    collateral: c.collateral,
    creditDecision: stored
      ? rehydrateDecision(c.customer.id, c.facility.currency, stored)
      : null,
    decisionCollateral: stored ? {
      eligibleCollateralValue: stored.breakdown.eligibleCollateralValue ?? '0.00',
      totalMarketValue: stored.breakdown.totalMarketValue ?? '0.00',
    } : null,
    previousRisk: await previousSnapshot(db, c.customer.id),
    tier: c.customer.tier,
    pointsBalance: rewards.posted,
    policy,
    now: ctx.now(),
  });
};

interface ModelResult {
  readonly text: string | null;
  readonly modelName: string | null;
  readonly error: string | null;
}

/**
 * Ask the configured model to rephrase. Any failure is a non-event: the caller
 * already holds a correct deterministic answer.
 */
const rephrase = async (
  ctx: AppContext, pack: FactPack, question: string, deterministic: string,
): Promise<ModelResult> => {
  const key = ctx.config.anthropicApiKey;
  if (!key) return { text: null, modelName: null, error: null };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ctx.config.anthropicModel,
        max_tokens: 400,
        temperature: 0,
        messages: [{ role: 'user', content: buildModelPrompt(pack, question, deterministic) }],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return { text: null, modelName: ctx.config.anthropicModel, error: `http_${response.status}` };
    }
    const body = await response.json() as { content?: { type: string; text?: string }[] };
    const text = body.content?.find((c) => c.type === 'text')?.text ?? null;
    return { text, modelName: ctx.config.anthropicModel, error: null };
  } catch (err) {
    return {
      text: null,
      modelName: ctx.config.anthropicModel,
      error: err instanceof Error ? err.name : 'unknown_error',
    };
  } finally {
    clearTimeout(timeout);
  }
};

export interface AskResult extends AgentAnswer {
  readonly interactionId: string;
  readonly factPack: FactPack;
}

export const ask = async (
  ctx: AppContext, db: Db, c: AgentContext, question: string,
): Promise<AskResult> => {
  const started = Date.now();
  const policy = getPolicy();
  const pack = await buildPack(ctx, db, c);
  const intent = classifyIntent(question);
  const amount = intent === 'transaction_impact' ? parseAmount(question, c.facility.currency) : null;
  const stored = await latestDecision(db, c.customer.id);

  const deterministic = explain(intent, {
    pack,
    facility: c.facility,
    risk: c.risk,
    collateral: c.collateral,
    creditDecision: stored ? rehydrateDecision(c.customer.id, c.facility.currency, stored) : null,
    previousRisk: await previousSnapshot(db, c.customer.id),
    policy,
    ...(amount ? { amount } : {}),
  });

  let text = deterministic.text;

  let modelUsed = false;
  let groundingRejected = false;
  let violations: string[] = [];
  let modelName: string | null = null;

  // Self-audit the deterministic answer against its own fact pack.
  //
  // The guardrail exists to stop *any* unsourced number reaching a customer,
  // not only ones a model wrote. The deterministic explainer quotes a stored
  // decision's sentences verbatim, and those were written against collateral
  // values from that moment; if pricing has moved far enough that a quoted
  // figure is no longer disclosable, the explanation is trimmed back to the
  // parts generated from live data rather than shipped with a number the
  // customer cannot trace.
  const selfCheck = groundingViolations(text, pack);
  if (!selfCheck.grounded) {
    violations = [...selfCheck.violations];
    groundingRejected = true;
    const sentences = text.split(/(?<=\.)\s+/);
    const grounded = sentences.filter((sentence) => groundingViolations(sentence, pack).grounded);
    text = grounded.length > 0
      ? grounded.join(' ')
      : `Your credit limit is ${c.facility.creditLimit.toFixedString()} ${c.facility.currency}. I am holding back part of this explanation because some figures in it could not be matched to current account data.`;
  }

  const draft = await rephrase(ctx, pack, question, text);
  modelName = draft.modelName;
  if (draft.text) {
    const check = groundingViolations(draft.text, pack);
    if (check.grounded) {
      text = draft.text;
      modelUsed = true;
    } else {
      groundingRejected = true;
      violations = [...violations, ...check.violations];
    }
  }

  const row = await query<{ id: string }>(
    db,
    `INSERT INTO ai_interactions
       (customer_id, question, intent, answer, fact_pack, cited_fact_keys, model_used,
        model_name, grounding_rejected, grounding_violations, latency_ms, policy_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [
      c.customer.id, question, intent, text,
      JSON.stringify(pack.facts.map((f) => ({
        key: f.key, label: f.label, value: f.value, unit: f.unit,
        asOf: f.asOf.toISOString(), source: f.source,
      }))),
      deterministic.citedFacts.map((f) => f.key),
      modelUsed, modelName, groundingRejected, violations,
      Date.now() - started, policy.version,
    ],
  );

  return {
    ...deterministic,
    text,
    modelUsed,
    groundingRejected,
    interactionId: row[0]!.id,
    factPack: pack,
  };
};

export type { AgentIntent };
