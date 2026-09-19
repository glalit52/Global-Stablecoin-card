/**
 * End-to-end demonstration.
 *
 * Walks one customer through the entire product against a running API:
 * onboarding and KYC, asset verification, a credit decision, card issuance,
 * everyday spending, an international purchase, the AI explaining the limit,
 * a market crash driving the risk ladder, a margin call, a liquidation plan,
 * dual-approved execution, and a final proof that the ledger still balances.
 *
 *   pnpm demo
 */

const API = process.env.API_URL ?? 'http://127.0.0.1:4000';
const PASSWORD = 'demo-walkthrough-2026!';

let step = 0;
const heading = (title: string): void => {
  step += 1;
  console.log(`\n\x1b[1m${String(step).padStart(2, '0')}. ${title}\x1b[0m`);
  console.log('─'.repeat(72));
};
const line = (label: string, value: unknown): void =>
  console.log(`   ${label.padEnd(34)} ${String(value)}`);
const note = (text: string): void => console.log(`   \x1b[2m${text}\x1b[0m`);

const call = async <T>(
  method: string, path: string, body?: unknown, token?: string,
): Promise<{ status: number; body: T }> => {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
};

const usd = (v: string | null | undefined): string => {
  if (!v) return '—';
  const [whole = '0', frac = '00'] = String(v).split('.');
  return `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac.padEnd(2, '0').slice(0, 2)}`;
};

const run = async (): Promise<void> => {
  const health = await call<{ status: string; policyVersion: string }>('GET', '/health');
  if (health.status !== 200) {
    console.error(`API is not reachable at ${API}. Start it with \`pnpm start:api\`.`);
    process.exitCode = 1;
    return;
  }

  const email = `demo-${Date.now()}@example.com`;

  // ---------------------------------------------------------------------
  heading('Onboarding and identity verification');
  const registered = await call<{ customerId: string; token: string; kyc: { status: string; sanctionsClear: boolean } }>(
    'POST', '/v1/auth/register', {
      email, password: PASSWORD, legalName: 'Imogen Adeyemi',
      dateOfBirth: '1984-09-02', jurisdiction: 'US',
      documentType: 'passport', documentNumber: 'P44817263',
    },
  );
  const token = registered.body.token;
  const customerId = registered.body.customerId;
  line('Customer', email);
  line('KYC status', registered.body.kyc.status);
  line('Sanctions screening', registered.body.kyc.sanctionsClear ? 'clear' : 'NOT CLEAR');
  line('Risk policy in force', health.body.policyVersion);

  // ---------------------------------------------------------------------
  heading('Connecting verified wealth');
  const operator = await call<{ token: string }>('POST', '/v1/operator/login', {
    email: 'risk@wealthcard.example', password: 'wealth-demo-2026!',
  });
  // Assets arrive from the custodian in production. Here they are placed
  // directly so the walkthrough needs nothing but a running API.
  const seeded = await call<{ ok?: boolean }>('POST', '/v1/admin/demo/seed-assets', {
    customerId,
    holdings: [
      { symbol: 'BTC', assetClass: 'BTC', quantity: '6' },
      { symbol: 'USDC', assetClass: 'STABLECOIN', quantity: '350000' },
      { symbol: 'ETH', assetClass: 'ETH', quantity: '55' },
    ],
    tier: 'PRIVATE',
  }, operator.body.token);
  if (seeded.status !== 200) {
    console.error('The demo asset endpoint is unavailable; is this a sandbox build?');
    process.exitCode = 1;
    return;
  }

  await call('POST', '/v1/account/refresh', {}, token);
  const wealth = await call<{
    totalWealth: string; eligibleCollateral: string;
    positions: { symbol: string; marketValue: string; eligibleValue: string; eligible: boolean; haircut: string; ineligibilityReasons: { explanation: string }[] }[];
  }>('GET', '/v1/wealth', undefined, token);

  line('Total connected wealth', usd(wealth.body.totalWealth));
  line('Eligible as collateral', usd(wealth.body.eligibleCollateral));
  for (const p of wealth.body.positions) {
    if (p.eligible) {
      line(`  ${p.symbol}`, `${usd(p.marketValue)} → ${usd(p.eligibleValue)} after a ${p.haircut}% haircut`);
    } else {
      line(`  ${p.symbol}`, `${usd(p.marketValue)} — ${p.ineligibilityReasons[0]?.explanation ?? 'not eligible'}`);
    }
  }

  // ---------------------------------------------------------------------
  heading('The credit decision');
  const credit = await call<{
    creditLimit: string; availableCredit: string; apr: string;
    decision: { explanations: string[] };
  }>('GET', '/v1/credit', undefined, token);
  line('Approved credit limit', usd(credit.body.creditLimit));
  line('APR', `${credit.body.apr}%`);
  console.log('');
  for (const e of credit.body.decision.explanations) note(`• ${e}`);

  // ---------------------------------------------------------------------
  heading('Issuing a card and spending');
  const card = await call<{ cardId: string; last4: string }>(
    'POST', '/v1/cards', { form: 'virtual', nameOnCard: 'IMOGEN ADEYEMI' }, token,
  );
  line('Virtual card', `•••• ${card.body.last4}`);

  const purchases = [
    { name: 'Whole Foods Market', mcc: '5411', amount: '184.32', currency: 'USD', country: 'US' },
    { name: 'Shell', mcc: '5541', amount: '68.40', currency: 'USD', country: 'US' },
    { name: 'Four Seasons George V', mcc: '7011', amount: '1240.00', currency: 'EUR', country: 'FR' },
  ];

  for (const p of purchases) {
    const requestId = `demo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const auth = await call<{ approved: boolean; billingAmount: string; fxRate: string | null; fxFee: string; latencyMs: number; declineReason: string | null }>(
      'POST', '/v1/card/authorize', {
        requestId, cardId: card.body.cardId, amount: p.amount, currency: p.currency,
        merchantId: `m_${p.mcc}`, merchantName: p.name, mcc: p.mcc,
        merchantCountry: p.country, entryMode: 'contactless',
      },
    );
    if (auth.body.approved) {
      const settled = await call<{ points: string }>('POST', '/v1/card/settle', { requestId });
      const fx = auth.body.fxRate
        ? ` (${p.amount} ${p.currency} at ${Number(auth.body.fxRate).toFixed(4)}, fee ${usd(auth.body.fxFee)})`
        : '';
      line(p.name, `${usd(auth.body.billingAmount)}${fx} · ${settled.body.points} points · ${auth.body.latencyMs}ms`);
    } else {
      line(p.name, `declined — ${auth.body.declineReason}`);
    }
  }

  // ---------------------------------------------------------------------
  heading('The merchant is paid, the customer keeps their assets');
  const afterSpend = await call<{ currentBalance: string; availableCredit: string }>(
    'GET', '/v1/credit', undefined, token,
  );
  const wealthAfter = await call<{ totalWealth: string }>('GET', '/v1/wealth', undefined, token);
  line('Card balance', usd(afterSpend.body.currentBalance));
  line('Available credit', usd(afterSpend.body.availableCredit));
  line('Wealth still held', usd(wealthAfter.body.totalWealth));
  note('No asset was sold to fund any of those purchases.');

  // ---------------------------------------------------------------------
  heading('Asking the assistant why');
  const ai = await call<{ answer: string; sources: { label: string; value: string; source: string }[]; modelUsed: boolean }>(
    'POST', '/v1/ai/query', { question: 'Explain my credit limit' }, token,
  );
  console.log(`   ${ai.body.answer.replace(/\. /g, '.\n   ')}`);
  console.log('');
  note(`Grounded in ${ai.body.sources.length} disclosed facts, each with a source and timestamp.`);
  note(`Language model used: ${ai.body.modelUsed ? 'yes, output passed the grounding check' : 'no, deterministic explainer'}`);

  // ---------------------------------------------------------------------
  heading('Drawing down against the line');
  const target = await call<{ availableCredit: string }>('GET', '/v1/credit', undefined, token);
  const draw = (Number(target.body.availableCredit) * 0.93).toFixed(2);
  const bigId = `demo-big-${Date.now()}`;
  const big = await call<{ approved: boolean; declineReason: string | null }>(
    'POST', '/v1/card/authorize', {
      requestId: bigId, cardId: card.body.cardId, amount: draw, currency: 'USD',
      merchantId: 'm_art', merchantName: "Sotheby's", mcc: '5999',
      merchantCountry: 'US', entryMode: 'ecommerce',
    },
  );
  if (big.body.approved) {
    await call('POST', '/v1/card/settle', { requestId: bigId });
    line("Sotheby's", usd(draw));
  } else {
    line("Sotheby's", `declined — ${big.body.declineReason}`);
  }

  const drawn = await call<{ state: string; effectiveLtv: string; healthPercent: string }>(
    'GET', '/v1/risk', undefined, token,
  );
  line('Risk state', drawn.body.state);
  line('Loan-to-value', `${drawn.body.effectiveLtv}%`);
  line('Portfolio health', `${drawn.body.healthPercent}%`);

  // ---------------------------------------------------------------------
  heading('Bitcoin falls 55%');
  await call('POST', '/v1/market/scenario', { symbol: 'BTC', changePercent: '-55' });
  const stressed = await call<{
    state: string; effectiveLtv: string; healthPercent: string;
    collateralCallAmount: string; repaymentToTarget: string;
    marginCall: { deadline: string; requiredAmount: string } | null;
  }>('GET', '/v1/risk', undefined, token);

  line('Risk state', stressed.body.state);
  line('Loan-to-value', `${stressed.body.effectiveLtv}%`);
  line('Portfolio health', `${stressed.body.healthPercent}%`);
  if (stressed.body.marginCall) {
    line('Margin call raised for', usd(stressed.body.marginCall.requiredAmount));
    line('Cure window closes', new Date(stressed.body.marginCall.deadline).toISOString());
  }

  const alerts = await call<{ alerts: { severity: string; title: string }[] }>(
    'GET', '/v1/alerts', undefined, token,
  );
  for (const a of alerts.body.alerts) note(`[${a.severity}] ${a.title}`);

  // ---------------------------------------------------------------------
  heading('The customer cures it by repaying');
  const cure = stressed.body.repaymentToTarget;
  if (Number(cure) > 0) {
    const repaid = await call<{ applied: Record<string, string>; balanceAfter: string; riskState: string }>(
      'POST', '/v1/repayment', {
        amount: cure, source: 'fiat', idempotencyKey: `demo-cure-${Date.now()}`,
      }, token,
    );
    line('Repaid', usd(cure));
    line('Applied to principal', usd(repaid.body.applied.principal));
    line('Balance after', usd(repaid.body.balanceAfter));
    line('Risk state', repaid.body.riskState);
    note('Adding eligible collateral would have worked just as well.');
  } else {
    note('No repayment was required at this level.');
  }

  // ---------------------------------------------------------------------
  heading('Operations: four-eyes control');
  const filed = await call<{ approvalId: string }>('POST', '/v1/admin/approvals', {
    action: 'credit.manual_limit_override',
    entityType: 'customer', entityId: customerId,
    payload: { creditLimit: '150000' },
    justification: 'Demonstration of the maker-checker control on a manual limit change.',
  }, operator.body.token);

  const selfApprove = await call<{ error?: { message: string } }>(
    'POST', `/v1/admin/approvals/${filed.body.approvalId}/approve`, {}, operator.body.token,
  );
  line('Requester tries to approve', `${selfApprove.status} — ${selfApprove.body.error?.message ?? 'approved'}`);

  const second = await call<{ token: string }>('POST', '/v1/operator/login', {
    email: 'admin2@wealthcard.example', password: 'wealth-demo-2026!',
  });
  const approved = await call<{ result: Record<string, string> }>(
    'POST', `/v1/admin/approvals/${filed.body.approvalId}/approve`, {}, second.body.token,
  );
  line('Second operator approves', `limit set to ${usd(approved.body.result?.creditLimit)}`);

  // ---------------------------------------------------------------------
  heading('The books');
  const recon = await call<{
    entryCount: number; balanced: boolean; residual: string;
    totalDebits: string; totalCredits: string;
    breaks: unknown[]; income: Record<string, string>;
  }>('GET', '/v1/admin/reconciliation', undefined, operator.body.token);

  line('Journal entries', recon.body.entryCount);
  line('Total debits', usd(recon.body.totalDebits));
  line('Total credits', usd(recon.body.totalCredits));
  line('Residual', usd(recon.body.residual));
  line('Reconciliation breaks', recon.body.breaks.length);
  console.log('');
  line('Interchange revenue', usd(recon.body.income.interchange));
  line('FX revenue', usd(recon.body.income.fx));
  line('Rewards cost', `−${usd(recon.body.income.rewardsCost)}`);
  line('Gross profit', usd(recon.body.income.grossProfit));
  line('Gross margin', `${recon.body.income.grossMargin}%`);

  const clean = recon.body.balanced && recon.body.breaks.length === 0;
  console.log('');
  console.log(clean
    ? '\x1b[32m   Debits equal credits exactly and no break was found.\x1b[0m'
    : '\x1b[31m   RECONCILIATION FAILED — see the breaks above.\x1b[0m');

  console.log(`\n\x1b[1mWalkthrough complete.\x1b[0m Customer: ${email}\n`);
  if (!clean) process.exitCode = 1;
};

run().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});

// This file has no imports, so the explicit export marks it as a module
// rather than a script sharing the global scope.
export {};
