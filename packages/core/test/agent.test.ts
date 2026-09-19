import { describe, it, expect } from 'vitest';
import {
  buildFactPack, classifyIntent, computeCollateral, computeRisk, D, decideCredit,
  explain, extractNumbers, findFact, getPolicy, groundingViolations, Money,
  valuePortfolio,
} from '../src/index.js';
import { ctx, facility, holding, price, T0, underwriting, usd } from './helpers.js';

const policy = getPolicy();

const scenario = (opts: { btcPrice?: string; principal?: string } = {}) => {
  const { valued } = valuePortfolio(
    [
      holding({ symbol: 'BTC', assetClass: 'BTC', quantity: D('5') }),
      holding({ symbol: 'USDC', assetClass: 'STABLECOIN', quantity: D('300000') }),
    ],
    ctx([price('BTC', opts.btcPrice ?? '100000'), price('USDC', '1.00')]),
  );
  const collateral = computeCollateral({ customerId: 'cust_1', jurisdiction: 'US', valued, policy, now: T0 });
  const f = facility({
    creditLimit: usd('300000'),
    principalBalance: usd(opts.principal ?? '8400'),
  });
  const risk = computeRisk({ facility: f, collateral, policy, now: T0 });
  const creditDecision = decideCredit({
    customerId: 'cust_1', collateral, underwriting: underwriting(),
    existingExposure: Money.zero('USD'), previousLimit: usd('280000'), policy, now: T0,
  });
  const pack = buildFactPack({
    facility: f, risk, collateral, creditDecision, previousRisk: null,
    tier: 'PRIVATE', pointsBalance: D('182400'), policy, now: T0,
  });
  return { collateral, facility: f, risk, creditDecision, pack };
};

describe('intent classification', () => {
  it('routes the PRD §16.1 questions to the right intent', () => {
    expect(classifyIntent('Why did my credit limit drop?')).toBe('why_changed');
    expect(classifyIntent('How much can I safely spend?')).toBe('safe_spend');
    expect(classifyIntent('What is my collateral health?')).toBe('collateral_health');
    expect(classifyIntent('Am I too concentrated in bitcoin?')).toBe('concentration_warning');
    expect(classifyIntent('What happens if I spend 20000?')).toBe('transaction_impact');
    expect(classifyIntent('How much do I owe and what is the minimum payment?')).toBe('repayment_options');
    expect(classifyIntent('What if BTC crashes 50%?')).toBe('stress_test');
    expect(classifyIntent('How many points do I have?')).toBe('rewards_summary');
    expect(classifyIntent('Explain my credit limit')).toBe('explain_limit');
    expect(classifyIntent('What is the capital of France?')).toBe('unsupported');
  });
});

describe('fact pack', () => {
  it('carries a timestamp and a source on every fact', () => {
    const { pack } = scenario();
    expect(pack.facts.length).toBeGreaterThan(15);
    for (const f of pack.facts) {
      expect(f.asOf).toBeInstanceOf(Date);
      expect(f.source).toBeTruthy();
      expect(f.value).toBeTruthy();
    }
  });

  it('includes the thresholds the customer is measured against', () => {
    const { pack } = scenario();
    expect(findFact(pack, 'liquidation_threshold')!.value).toBe('85');
    expect(findFact(pack, 'advance_rate')!.value).toBe('50');
    expect(findFact(pack, 'watch_threshold')!.value).toBe('60');
  });

  it('exposes per-position facts so the agent can name the mover', () => {
    const { pack } = scenario();
    expect(findFact(pack, 'position_BTC_value')!.value).toBe('500000.00');
    expect(findFact(pack, 'position_BTC_haircut')!.value).toBe('30.0');
    expect(findFact(pack, 'position_USDC_eligible')).toBeDefined();
  });

  it('marks the pack degraded when inputs are degraded', () => {
    const stale = new Date(T0.getTime() - 3_600_000);
    const { valued } = valuePortfolio(
      [holding({ symbol: 'BTC', assetClass: 'BTC', quantity: D('5') })],
      ctx([price('BTC', '100000', stale)]),
    );
    const collateral = computeCollateral({ customerId: 'cust_1', jurisdiction: 'US', valued, policy, now: T0 });
    const f = facility({ principalBalance: usd('1000') });
    const risk = computeRisk({ facility: f, collateral, policy, now: T0 });
    const pack = buildFactPack({
      facility: f, risk, collateral, creditDecision: null, previousRisk: null,
      tier: 'PRIVATE', pointsBalance: D('0'), policy, now: T0,
    });
    expect(pack.degraded).toBe(true);
  });
});

describe('deterministic explanations', () => {
  const answerFor = (intent: Parameters<typeof explain>[0], extra: Record<string, unknown> = {}) => {
    const s = scenario();
    return explain(intent, {
      pack: s.pack, facility: s.facility, risk: s.risk, collateral: s.collateral,
      creditDecision: s.creditDecision, previousRisk: null, policy, ...extra,
    });
  };

  it('explains the limit from the actual factor chain', () => {
    const a = answerFor('explain_limit');
    expect(a.text).toMatch(/credit limit is 300,000\.00 USD/);
    expect(a.text).toMatch(/advance rate/);
    expect(a.citedFacts.map((f) => f.key)).toContain('eligible_collateral');
    expect(a.modelUsed).toBe(false);
    // Prose carries thousands separators; API payloads deliberately do not.
    expect(a.text).not.toMatch(/\b\d{7,}\.\d{2}\b/);
  });

  it('answers safe spend with the risk-bounded figure and says why', () => {
    const a = answerFor('safe_spend');
    expect(a.text).toMatch(/You can spend/);
    expect(a.citedFacts.map((f) => f.key)).toContain('safe_spend');
  });

  it('reports collateral health with the liquidation headroom', () => {
    const a = answerFor('collateral_health');
    expect(a.text).toMatch(/portfolio health is/);
    expect(a.text).toMatch(/could fall .* before we would need to act/);
  });

  it('attributes a change when a previous snapshot exists', () => {
    const before = scenario({ btcPrice: '100000' });
    const after = scenario({ btcPrice: '70000' });
    const a = explain('why_changed', {
      pack: after.pack, facility: after.facility, risk: after.risk, collateral: after.collateral,
      creditDecision: after.creditDecision, previousRisk: before.risk, policy,
    });
    expect(a.text).toMatch(/fell from/);
    expect(a.text).toMatch(/BTC/);
  });

  it('says plainly when it has no baseline to compare against', () => {
    const a = answerFor('why_changed');
    expect(a.text).toMatch(/do not have an earlier snapshot/);
  });

  it('runs a real stress test rather than describing one', () => {
    const a = answerFor('stress_test');
    expect(a.text).toMatch(/BTC -30%/);
    expect(a.text).toMatch(/BTC -70%/);
  });

  it('always attaches an as-of line and a not-advice disclaimer', () => {
    for (const intent of ['explain_limit', 'collateral_health', 'safe_spend', 'stress_test'] as const) {
      const a = answerFor(intent);
      expect(a.disclaimers.join(' ')).toMatch(/Values as of \d{2} \w{3} \d{4}, \d{2}:\d{2} UTC/);
      expect(a.disclaimers.join(' ')).toMatch(/not financial advice/);
    }
  });

  it('offers what it can do instead of guessing on an unsupported question', () => {
    const a = answerFor('unsupported');
    expect(a.text).toMatch(/I can explain/);
  });

  it('stamps the policy version on every answer', () => {
    expect(answerFor('explain_limit').policyVersion).toBe(policy.version);
  });
});

describe('grounding guardrail', () => {
  it('extracts numbers from prose in every common shape', () => {
    expect(extractNumbers('Your limit is $300,000.00 and health is 92.4%.')).toEqual(['300000.00', '92.4']);
    expect(extractNumbers('No numbers here.')).toEqual([]);
  });

  it('passes an answer built only from the fact pack', () => {
    const s = scenario();
    const a = explain('explain_limit', {
      pack: s.pack, facility: s.facility, risk: s.risk, collateral: s.collateral,
      creditDecision: s.creditDecision, previousRisk: null, policy,
    });
    const g = groundingViolations(a.text, s.pack);
    expect(g.violations).toEqual([]);
    expect(g.grounded).toBe(true);
  });

  it('ignores timestamps, which are provenance rather than claims', () => {
    const { pack } = scenario();
    expect(groundingViolations('Values as of 19 Sep 2026, 14:07 UTC.', pack).grounded).toBe(true);
    expect(groundingViolations('Priced at 2026-09-19T14:07:33.000Z.', pack).grounded).toBe(true);
    // A fabricated figure alongside a real timestamp is still caught.
    expect(groundingViolations('As of 19 Sep 2026, 14:07 UTC your balance is 88123.45.', pack).grounded).toBe(false);
  });

  it('rejects a fabricated balance', () => {
    const { pack } = scenario();
    const g = groundingViolations('Your available credit is 999999.00 USD.', pack);
    expect(g.grounded).toBe(false);
    expect(g.violations).toContain('999999.00');
  });

  it('rejects a plausible-looking but invented percentage', () => {
    const { pack } = scenario();
    expect(groundingViolations('Your portfolio health is 73.6%.', pack).grounded).toBe(false);
  });

  it('accepts a real figure restated at a different precision', () => {
    const { pack } = scenario();
    const health = findFact(pack, 'portfolio_health')!.value;
    expect(groundingViolations(`Your health is ${health}%.`, pack).grounded).toBe(true);
  });

  it('lets small integers through so the model can write a sentence', () => {
    const { pack } = scenario();
    expect(groundingViolations('You have 2 eligible assets and 1 card.', pack).grounded).toBe(true);
  });

  it('catches a fabricated price that is not in the pack', () => {
    const { pack } = scenario();
    expect(groundingViolations('Bitcoin is trading at 118432.00 today.', pack).grounded).toBe(false);
  });
});
