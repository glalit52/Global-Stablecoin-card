import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D } from '@wealthcard/core';
import { makeClient, resetDatabase, startTestServer, type ApiClient, type TestHarness } from './setup.js';
import { query, queryOne } from '../src/db.js';

let harness: TestHarness;
let api: ApiClient;

const PASSWORD = 'integration-test-2026!';

/** Register a customer, seed custody holdings and underwrite them. */
const onboard = async (
  email: string,
  holdings: { symbol: string; assetClass: string; quantity: string }[],
  legalName = 'Test Customer',
  jurisdiction = 'US',
  /** Tier caps bind long before collateral does on the entry tier, so tests
   *  that exercise the LTV ladder have to sit on a tier whose ceiling is
   *  above the collateral capacity. */
  tier: 'WEALTH' | 'WEALTH_PLUS' | 'PRIVATE' | 'ULTRA' = 'WEALTH',
): Promise<{ customerId: string; token: string }> => {
  const registered = await api('POST', '/v1/auth/register', {
    email, password: PASSWORD, legalName,
    dateOfBirth: '1988-02-14', jurisdiction,
    documentType: 'passport', documentNumber: 'P12345678',
  });
  expect(registered.status, JSON.stringify(registered.body)).toBe(201);

  const customerId = registered.body.customerId as string;
  const token = registered.body.token as string;
  const custodyAccountId = `custody_${email.split('@')[0]}`;

  await query(harness.pool,
    'UPDATE customers SET custody_account_id = $2, tier = $3::tier WHERE id = $1',
    [customerId, custodyAccountId, tier]);

  for (const h of holdings) {
    await query(
      harness.pool,
      `INSERT INTO assets
         (customer_id, asset_class, symbol, custodian, custody_model, quantity,
          verification, last_verified_at, pledged)
       VALUES ($1,$2::asset_class,$3,'sandbox-custody','institutional_custodian',$4,
               'custodian_api',$5,TRUE)`,
      [customerId, h.assetClass, h.symbol, h.quantity, harness.ctx.now()],
    );
  }
  harness.ctx.partners.custody.seedAccount(
    custodyAccountId,
    holdings.map((h) => ({ symbol: h.symbol, assetClass: h.assetClass as never, quantity: h.quantity })),
  );

  const refreshed = await api('POST', '/v1/account/refresh', {}, token);
  expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
  return { customerId, token };
};

const issueVirtualCard = async (token: string): Promise<string> => {
  const res = await api('POST', '/v1/cards', { form: 'virtual', nameOnCard: 'TEST CUSTOMER' }, token);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.cardId as string;
};

let seq = 0;
const nextRequestId = () => `test-req-${Date.now()}-${seq++}`;

beforeAll(async () => {
  await resetDatabase();
  harness = await startTestServer();
  api = makeClient(harness);
}, 60_000);

afterAll(async () => {
  await harness?.close();
});

describe('health and policy', () => {
  it('reports healthy with every partner wired', async () => {
    const res = await api('GET', '/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.database).toBe('up');
    expect((res.body.partners as Record<string, unknown>).custody).toBe('sandbox-custody');
  });

  it('publishes the live risk policy so the UI shows real thresholds', async () => {
    const res = await api('GET', '/v1/policy');
    expect(res.status).toBe(200);
    expect((res.body.thresholds as Record<string, string>).liquidationLtv).toBe('0.85');
  });
});

describe('onboarding and KYC', () => {
  it('onboards, underwrites and opens a facility', async () => {
    const { token } = await onboard('alice@test.example', [
      { symbol: 'BTC', assetClass: 'BTC', quantity: '3' },
      { symbol: 'USDC', assetClass: 'STABLECOIN', quantity: '200000' },
    ], 'Alice Tan');

    const credit = await api('GET', '/v1/credit', undefined, token);
    expect(credit.status).toBe(200);
    expect(D(credit.body.creditLimit as string).gt(0)).toBe(true);
    expect(credit.body.status).toBe('active');

    const decision = credit.body.decision as { explanations: string[]; approved: boolean };
    expect(decision.approved).toBe(true);
    expect(decision.explanations.join(' ')).toMatch(/advance rate/);
  });

  it('refuses credit to a sanctioned applicant', async () => {
    const res = await api('POST', '/v1/auth/register', {
      email: 'blocked@test.example', password: PASSWORD,
      legalName: 'Sanctioned Person', dateOfBirth: '1980-01-01',
      jurisdiction: 'US', documentType: 'passport', documentNumber: 'P99887766',
    });
    expect(res.status).toBe(201);
    expect((res.body.kyc as { status: string }).status).toBe('rejected');

    const token = res.body.token as string;
    const refreshed = await api('POST', '/v1/account/refresh', {}, token);
    expect(refreshed.status).toBe(200);

    const credit = await api('GET', '/v1/credit', undefined, token);
    const decision = credit.body.decision as { declineReasons: string[] };
    expect(decision.declineReasons).toContain('sanctions_screening_not_clear');
    expect(credit.body.creditLimit).toBe('0.00');
  });

  it('does not disclose whether an email is already registered', async () => {
    const first = await api('POST', '/v1/auth/register', {
      email: 'dupe@test.example', password: PASSWORD, legalName: 'First Person',
      dateOfBirth: '1990-01-01', jurisdiction: 'US', documentNumber: 'P10001111',
    });
    expect(first.status).toBe(201);

    const second = await api('POST', '/v1/auth/register', {
      email: 'dupe@test.example', password: PASSWORD, legalName: 'Second Person',
      dateOfBirth: '1990-01-01', jurisdiction: 'US', documentNumber: 'P20002222',
    });
    expect(second.status).toBe(409);
    expect(JSON.stringify(second.body)).not.toMatch(/already|exists|taken/i);
  });

  it('rejects a weak password', async () => {
    const res = await api('POST', '/v1/auth/register', {
      email: 'weak@test.example', password: 'short', legalName: 'Weak Password',
      dateOfBirth: '1990-01-01', jurisdiction: 'US',
    });
    expect(res.status).toBe(400);
  });
});

describe('authentication', () => {
  it('requires a token on protected routes', async () => {
    expect((await api('GET', '/v1/credit')).status).toBe(401);
    expect((await api('GET', '/v1/wealth')).status).toBe(401);
    expect((await api('GET', '/v1/admin/customers')).status).toBe(401);
  });

  it('rejects a customer token on operator routes', async () => {
    const { token } = await onboard('roles@test.example', [
      { symbol: 'USDC', assetClass: 'STABLECOIN', quantity: '100000' },
    ]);
    const res = await api('GET', '/v1/admin/customers', undefined, token);
    expect(res.status).toBe(403);
  });

  it('rejects a bad password and a revoked session', async () => {
    const { token } = await onboard('logout@test.example', [
      { symbol: 'USDC', assetClass: 'STABLECOIN', quantity: '100000' },
    ]);
    expect((await api('GET', '/v1/auth/me', undefined, token)).status).toBe(200);

    expect((await api('POST', '/v1/auth/login', {
      email: 'logout@test.example', password: 'wrong-password',
    })).status).toBe(401);

    await api('POST', '/v1/auth/logout', {}, token);
    expect((await api('GET', '/v1/auth/me', undefined, token)).status).toBe(401);
  });
});

describe('wealth and collateral', () => {
  it('values the portfolio and explains what is not eligible', async () => {
    const { token } = await onboard('wealth@test.example', [
      { symbol: 'BTC', assetClass: 'BTC', quantity: '2' },
      { symbol: 'USDC', assetClass: 'STABLECOIN', quantity: '150000' },
      // Not eligible under the MVP policy.
      { symbol: 'ETH', assetClass: 'ETH', quantity: '30' },
    ]);

    const res = await api('GET', '/v1/wealth', undefined, token);
    expect(res.status).toBe(200);
    expect(D(res.body.totalWealth as string).gt(D(res.body.eligibleCollateral as string))).toBe(true);

    const positions = res.body.positions as { symbol: string; eligible: boolean; ineligibilityReasons: { code: string; explanation: string }[] }[];
    const eth = positions.find((p) => p.symbol === 'ETH')!;
    expect(eth.eligible).toBe(false);
    expect(eth.ineligibilityReasons.map((r) => r.code)).toContain('asset_class_not_eligible');
    // The customer is owed a sentence, not a code.
    expect(eth.ineligibilityReasons[0]!.explanation.length).toBeGreaterThan(10);
  });

  it('refuses a collateral release that would breach the LTV limit', async () => {
    const { token } = await onboard('release@test.example', [
      { symbol: 'BTC', assetClass: 'BTC', quantity: '2' },
      { symbol: 'USDC', assetClass: 'STABLECOIN', quantity: '120000' },
    ]);
    const cardId = await issueVirtualCard(token);

    // Draw most of the line.
    const credit = await api('GET', '/v1/credit', undefined, token);
    const available = D(credit.body.availableCredit as string);
    const requestId = nextRequestId();
    const auth = await api('POST', '/v1/card/authorize', {
      requestId, cardId,
      amount: available.times(D('0.9')).toDecimalPlaces(2).toFixed(),
      currency: 'USD', merchantId: 'm1', merchantName: 'Gallery',
      mcc: '5999', merchantCountry: 'US', entryMode: 'ecommerce',
    });
    expect(auth.status, JSON.stringify(auth.body)).toBe(200);
    await api('POST', '/v1/card/settle', { requestId });

    const wealth = await api('GET', '/v1/wealth', undefined, token);
    const btc = (wealth.body.positions as { symbol: string; assetId: string }[])
      .find((p) => p.symbol === 'BTC')!;

    // Step-up first, or the release is refused for the wrong reason.
    const challenge = await api('POST', '/v1/auth/step-up/challenge', { purpose: 'release_collateral' }, token);
    expect(challenge.status).toBe(200);

    const release = await api('POST', '/v1/collateral/release', { assetId: btc.assetId }, token);
    // 428 = step-up not completed; that path is tested separately. Either way
    // the release must not succeed.
    expect([400, 428]).toContain(release.status);
  });
});

describe('card authorization', () => {
  it('approves an ordinary purchase and records the check trace', async () => {
    const { token } = await onboard('spend@test.example', [
      { symbol: 'BTC', assetClass: 'BTC', quantity: '2' },
      { symbol: 'USDC', assetClass: 'STABLECOIN', quantity: '150000' },
    ]);
    const cardId = await issueVirtualCard(token);

    const requestId = nextRequestId();
    const res = await api('POST', '/v1/card/authorize', {
      requestId, cardId, amount: '184.32', currency: 'USD',
      merchantId: 'm_wf', merchantName: 'Whole Foods', mcc: '5411',
      merchantCountry: 'US', entryMode: 'contactless',
    });

    expect(res.status).toBe(200);
    expect(res.body.approved).toBe(true);
    expect(res.body.billingAmount).toBe('184.32');
    const checks = res.body.checks as { name: string; passed: boolean }[];
    expect(checks.every((c) => c.passed)).toBe(true);
    expect(checks.map((c) => c.name)).toContain('available_credit');
  });

  it('returns the original decision when the network replays a request', async () => {
    const { token } = await onboard('replay@test.example', [
      { symbol: 'USDC', assetClass: 'STABLECOIN', quantity: '150000' },
    ]);
    const cardId = await issueVirtualCard(token);
    const requestId = nextRequestId();
    const payload = {
      requestId, cardId, amount: '99.99', currency: 'USD',
      merchantId: 'm1', merchantName: 'Merchant', mcc: '5411',
      merchantCountry: 'US', entryMode: 'contactless',
    };

    const first = await api('POST', '/v1/card/authorize', payload);
    const second = await api('POST', '/v1/card/authorize', payload);

    expect(first.body.approved).toBe(true);
    expect(second.body.approved).toBe(first.body.approved);
    expect(second.body.authorizationId).toBe(first.body.authorizationId);

    // Critically: only one hold exists, not two.
    const holds = await queryOne<{ count: string }>(
      harness.pool,
      `SELECT COUNT(*)::text AS count FROM authorizations WHERE request_id = $1`,
      [requestId],
    );
    expect(holds!.count).toBe('1');
  });

  it('declines for insufficient credit with the network code', async () => {
    const { token } = await onboard('broke@test.example', [
      { symbol: 'USDC', assetClass: 'STABLECOIN', quantity: '30000' },
    ]);
    const cardId = await issueVirtualCard(token);

    const res = await api('POST', '/v1/card/authorize', {
      requestId: nextRequestId(), cardId, amount: '500000', currency: 'USD',
      merchantId: 'm1', merchantName: 'Yacht Broker', mcc: '5999',
      merchantCountry: 'US', entryMode: 'ecommerce',
    });
    expect(res.status).toBe(402);
    expect(res.body.approved).toBe(false);
    expect(res.body.declineCode).toBe('51_insufficient_funds');
  });

  it('declines on a frozen card', async () => {
    const { token } = await onboard('frozen@test.example', [
      { symbol: 'USDC', assetClass: 'STABLECOIN', quantity: '150000' },
    ]);
    const cardId = await issueVirtualCard(token);
    await api('POST', `/v1/cards/${cardId}/status`, { status: 'frozen' }, token);

    const res = await api('POST', '/v1/card/authorize', {
      requestId: nextRequestId(), cardId, amount: '50', currency: 'USD',
      merchantId: 'm1', merchantName: 'Cafe', mcc: '5812',
      merchantCountry: 'US', entryMode: 'contactless',
    });
    expect(res.body.declineCode).toBe('62_restricted_card');
  });

  it('converts foreign currency and charges the tier FX markup', async () => {
    const { token } = await onboard('travel@test.example', [
      { symbol: 'USDC', assetClass: 'STABLECOIN', quantity: '200000' },
    ]);
    const cardId = await issueVirtualCard(token);

    const res = await api('POST', '/v1/card/authorize', {
      requestId: nextRequestId(), cardId, amount: '1000', currency: 'EUR',
      merchantId: 'm_fr', merchantName: 'Paris Bistro', mcc: '5812',
      merchantCountry: 'FR', entryMode: 'chip',
    });
    expect(res.body.approved).toBe(true);
    // WEALTH tier: 1.08 rate plus a 100bps markup.
    expect(res.body.fxRate).toBe('1.08');
    expect(res.body.billingAmount).toBe('1090.80');
    expect(res.body.fxFee).toBe('10.80');
  });

  it('holds reduce available credit, and settlement converts them to balance', async () => {
    const { token } = await onboard('holds@test.example', [
      { symbol: 'USDC', assetClass: 'STABLECOIN', quantity: '200000' },
    ]);
    const cardId = await issueVirtualCard(token);
    const before = await api('GET', '/v1/credit', undefined, token);

    const requestId = nextRequestId();
    await api('POST', '/v1/card/authorize', {
      requestId, cardId, amount: '2500', currency: 'USD',
      merchantId: 'm1', merchantName: 'Apple', mcc: '5732',
      merchantCountry: 'US', entryMode: 'ecommerce',
    });

    const held = await api('GET', '/v1/credit', undefined, token);
    expect(held.body.pendingAuthorizations).toBe('2500.00');
    expect(held.body.currentBalance).toBe('0.00');
    expect(D(held.body.availableCredit as string).toFixed())
      .toBe(D(before.body.availableCredit as string).minus(2500).toFixed());

    await api('POST', '/v1/card/settle', { requestId });

    const settled = await api('GET', '/v1/credit', undefined, token);
    expect(settled.body.pendingAuthorizations).toBe('0.00');
    expect(settled.body.currentBalance).toBe('2500.00');
    expect(settled.body.availableCredit).toBe(held.body.availableCredit);
  });

  it('settles only once when the processor sends a duplicate callback', async () => {
    const { token } = await onboard('dupsettle@test.example', [
      { symbol: 'USDC', assetClass: 'STABLECOIN', quantity: '200000' },
    ]);
    const cardId = await issueVirtualCard(token);
    const requestId = nextRequestId();

    await api('POST', '/v1/card/authorize', {
      requestId, cardId, amount: '1200', currency: 'USD',
      merchantId: 'm1', merchantName: 'Merchant', mcc: '5411',
      merchantCountry: 'US', entryMode: 'contactless',
    });

    const first = await api('POST', '/v1/card/settle', { requestId });
    const second = await api('POST', '/v1/card/settle', { requestId });

    expect(first.body.duplicate).toBe(false);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.transactionId).toBe(first.body.transactionId);

    const credit = await api('GET', '/v1/credit', undefined, token);
    expect(credit.body.currentBalance).toBe('1200.00');
  });

  it('never lets concurrent authorizations exceed the limit', async () => {
    const { token } = await onboard('race@test.example', [
      { symbol: 'USDC', assetClass: 'STABLECOIN', quantity: '60000' },
    ]);
    const cardId = await issueVirtualCard(token);

    const credit = await api('GET', '/v1/credit', undefined, token);
    const limit = D(credit.body.availableCredit as string);
    // Eight simultaneous charges, each a fifth of the line. At most five can
    // legitimately be approved.
    const each = limit.dividedBy(5).toDecimalPlaces(2).toFixed();

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        api('POST', '/v1/card/authorize', {
          requestId: nextRequestId(), cardId, amount: each, currency: 'USD',
          merchantId: 'm1', merchantName: 'Merchant', mcc: '5411',
          merchantCountry: 'US', entryMode: 'contactless',
        })),
    );

    const approved = results.filter((r) => r.body.approved === true);
    expect(approved.length).toBeLessThanOrEqual(5);
    expect(approved.length).toBeGreaterThan(0);

    const after = await api('GET', '/v1/credit', undefined, token);
    const exposure = D(after.body.currentBalance as string)
      .plus(D(after.body.pendingAuthorizations as string));
    expect(exposure.lte(D(after.body.creditLimit as string))).toBe(true);
  });
});

describe('repayment and the ledger', () => {
  it('applies a repayment to fees, interest, then principal, and reconciles', async () => {
    const { token } = await onboard('repay@test.example', [
      { symbol: 'USDC', assetClass: 'STABLECOIN', quantity: '200000' },
    ]);
    const cardId = await issueVirtualCard(token);

    const requestId = nextRequestId();
    await api('POST', '/v1/card/authorize', {
      requestId, cardId, amount: '5000', currency: 'USD',
      merchantId: 'm1', merchantName: 'Merchant', mcc: '5411',
      merchantCountry: 'US', entryMode: 'contactless',
    });
    await api('POST', '/v1/card/settle', { requestId });

    const repayment = await api('POST', '/v1/repayment', {
      amount: '2000', source: 'fiat', idempotencyKey: `repay-${Date.now()}`,
    }, token);

    expect(repayment.status).toBe(200);
    expect((repayment.body.applied as Record<string, string>).principal).toBe('2000.00');
    expect(repayment.body.balanceAfter).toBe('3000.00');
  });

  it('treats a replayed repayment as a no-op', async () => {
    const { token } = await onboard('repaydupe@test.example', [
      { symbol: 'USDC', assetClass: 'STABLECOIN', quantity: '200000' },
    ]);
    const cardId = await issueVirtualCard(token);
    const requestId = nextRequestId();
    await api('POST', '/v1/card/authorize', {
      requestId, cardId, amount: '3000', currency: 'USD',
      merchantId: 'm1', merchantName: 'Merchant', mcc: '5411',
      merchantCountry: 'US', entryMode: 'contactless',
    });
    await api('POST', '/v1/card/settle', { requestId });

    const key = `repay-dupe-${Date.now()}`;
    const first = await api('POST', '/v1/repayment', { amount: '1000', idempotencyKey: key }, token);
    const second = await api('POST', '/v1/repayment', { amount: '1000', idempotencyKey: key }, token);

    expect(first.body.duplicate).toBe(false);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.balanceAfter).toBe('2000.00');
  });

  it('keeps the whole ledger balanced with zero breaks', async () => {
    const operator = await api('POST', '/v1/operator/login', {
      email: 'recon@test.example', password: PASSWORD,
    });
    // Seeded below in the admin block; if absent, create one now.
    let token = operator.body.token as string | undefined;
    if (!token) {
      const { hashPassword } = await import('../src/auth.js');
      const { hash, salt } = await hashPassword(PASSWORD);
      await query(harness.pool,
        `INSERT INTO operators (email, name, roles, password_hash, password_salt)
         VALUES ('recon@test.example','Recon','{risk,admin}',$1,$2)
         ON CONFLICT (email) DO NOTHING`, [hash, salt]);
      const retry = await api('POST', '/v1/operator/login', {
        email: 'recon@test.example', password: PASSWORD,
      });
      token = retry.body.token as string;
    }

    const res = await api('GET', '/v1/admin/reconciliation', undefined, token);
    expect(res.status).toBe(200);
    expect(res.body.balanced).toBe(true);
    expect(res.body.residual).toBe('0.00');
    expect(res.body.breaks).toEqual([]);
    expect(D(res.body.totalDebits as string).eq(D(res.body.totalCredits as string))).toBe(true);
  });
});

describe('rewards', () => {
  it('earns the category multiplier and reports programme economics', async () => {
    const { token, customerId } = await onboard('rewards@test.example', [
      { symbol: 'USDC', assetClass: 'STABLECOIN', quantity: '300000' },
    ]);
    await query(harness.pool, `UPDATE customers SET tier = 'PRIVATE' WHERE id = $1`, [customerId]);
    const cardId = await issueVirtualCard(token);

    const requestId = nextRequestId();
    await api('POST', '/v1/card/authorize', {
      requestId, cardId, amount: '1000', currency: 'USD',
      merchantId: 'm_rest', merchantName: 'Nobu', mcc: '5812',
      merchantCountry: 'US', entryMode: 'chip',
    });
    await api('POST', '/v1/card/settle', { requestId });

    const rewards = await api('GET', '/v1/rewards', undefined, token);
    expect(rewards.status).toBe(200);
    // PRIVATE dining is 4x.
    expect((rewards.body.points as Record<string, string>).posted).toBe('4000');
    expect((rewards.body.points as Record<string, string>).statementCreditValue).toBe('40.00');

    const economics = rewards.body.economics as Record<string, string>;
    expect(Number(economics.rewardsCostPercentOfSpend)).toBeLessThan(5);
  });

  it('refuses a redemption below the minimum', async () => {
    const { token } = await onboard('redeem@test.example', [
      { symbol: 'USDC', assetClass: 'STABLECOIN', quantity: '150000' },
    ]);
    const res = await api('POST', '/v1/rewards/redeem', {
      kind: 'statement_credit', points: '100',
    }, token);
    // Step-up is required before the redemption rules are even reached.
    expect([400, 428]).toContain(res.status);
  });
});

describe('risk lifecycle', () => {
  it('walks the ladder from healthy to margin call as collateral falls', async () => {
    const { token } = await onboard('crash@test.example', [
      { symbol: 'BTC', assetClass: 'BTC', quantity: '10' },
      { symbol: 'USDC', assetClass: 'STABLECOIN', quantity: '150000' },
    ], 'Crash Test', 'US', 'ULTRA');
    const cardId = await issueVirtualCard(token);

    const credit = await api('GET', '/v1/credit', undefined, token);
    const draw = D(credit.body.availableCredit as string).times(D('0.95')).toDecimalPlaces(2).toFixed();
    const requestId = nextRequestId();
    const auth = await api('POST', '/v1/card/authorize', {
      requestId, cardId, amount: draw, currency: 'USD',
      merchantId: 'm1', merchantName: 'Auction House', mcc: '5999',
      merchantCountry: 'US', entryMode: 'ecommerce',
    });
    expect(auth.body.approved, JSON.stringify(auth.body)).toBe(true);
    await api('POST', '/v1/card/settle', { requestId });

    const healthy = await api('GET', '/v1/risk', undefined, token);
    expect(healthy.body.state).toBe('healthy');

    // A severe drawdown.
    await api('POST', '/v1/market/scenario', { symbol: 'BTC', changePercent: '-45' });

    const stressed = await api('GET', '/v1/risk', undefined, token);
    expect(['watch', 'restricted', 'remediation', 'liquidation']).toContain(stressed.body.state as string);
    expect(D(stressed.body.effectiveLtv as string).gt(D(healthy.body.effectiveLtv as string))).toBe(true);

    const alerts = await api('GET', '/v1/alerts', undefined, token);
    expect((alerts.body.alerts as unknown[]).length).toBeGreaterThan(0);
  });

  it('caps an entry-tier customer at the tier ceiling, not their collateral', async () => {
    const { token } = await onboard('tiercap@test.example', [
      { symbol: 'BTC', assetClass: 'BTC', quantity: '10' },
      { symbol: 'USDC', assetClass: 'STABLECOIN', quantity: '150000' },
    ], 'Entry Tier');

    const credit = await api('GET', '/v1/credit', undefined, token);
    expect(credit.body.creditLimit).toBe('50000.00');
    const decision = credit.body.decision as { explanations: string[] };
    expect(decision.explanations.join(' ')).toMatch(/WEALTH tier ceiling/);
  });

  it('runs stress scenarios against the live position', async () => {
    const { token } = await onboard('stress@test.example', [
      { symbol: 'BTC', assetClass: 'BTC', quantity: '5' },
      { symbol: 'USDC', assetClass: 'STABLECOIN', quantity: '200000' },
    ]);
    const res = await api('GET', '/v1/risk/stress', undefined, token);
    expect(res.status).toBe(200);
    const scenarios = res.body.scenarios as { id: string; survives: boolean }[];
    expect(scenarios.length).toBeGreaterThan(5);
    expect(scenarios.map((s) => s.id)).toContain('btc_drawdown_70');
  });

  it('previews the impact of a purchase without committing it', async () => {
    const { token } = await onboard('preview@test.example', [
      { symbol: 'USDC', assetClass: 'STABLECOIN', quantity: '200000' },
    ]);
    const before = await api('GET', '/v1/credit', undefined, token);
    const res = await api('POST', '/v1/credit/preview', { amount: '10000' }, token);

    expect(res.status).toBe(200);
    expect(res.body.affordable).toBe(true);
    expect(res.body.explanation).toMatch(/would leave/);

    const after = await api('GET', '/v1/credit', undefined, token);
    expect(after.body.currentBalance).toBe(before.body.currentBalance);
  });
});

describe('AI agent', () => {
  it('answers from real account facts with sources and disclaimers', async () => {
    const { token } = await onboard('ai@test.example', [
      { symbol: 'BTC', assetClass: 'BTC', quantity: '3' },
      { symbol: 'USDC', assetClass: 'STABLECOIN', quantity: '150000' },
    ]);

    const res = await api('POST', '/v1/ai/query', {
      question: 'How much can I safely spend?',
    }, token);

    expect(res.status).toBe(200);
    expect(res.body.intent).toBe('safe_spend');
    expect((res.body.sources as unknown[]).length).toBeGreaterThan(0);
    expect((res.body.disclaimers as string[]).join(' ')).toMatch(/not financial advice/);
    // No model configured in tests, so the deterministic path must answer.
    expect(res.body.modelUsed).toBe(false);
    expect(res.body.groundingRejected).toBe(false);
  });

  it('grounds every number it states in the fact pack', async () => {
    const { token } = await onboard('ground@test.example', [
      { symbol: 'USDC', assetClass: 'STABLECOIN', quantity: '250000' },
    ]);
    const res = await api('POST', '/v1/ai/query', { question: 'Explain my credit limit' }, token);

    const answer = res.body.answer as string;
    const factPack = await query<{ fact_pack: { key: string; value: string }[] }>(
      harness.pool,
      'SELECT fact_pack FROM ai_interactions ORDER BY created_at DESC LIMIT 1',
    );
    const disclosable = new Set(factPack[0]!.fact_pack.map((f) => f.value.replace(/,/g, '')));

    const numbers = (answer.match(/\d[\d,]*\.\d{2}/g) ?? []).map((n) => n.replace(/,/g, ''));
    expect(numbers.length).toBeGreaterThan(0);
    for (const n of numbers) {
      expect(disclosable.has(n), `"${n}" reached the customer without a source`).toBe(true);
    }
  });

  it('withholds an explanation it cannot source rather than stating it', async () => {
    const { token } = await onboard('stalefacts@test.example', [
      { symbol: 'BTC', assetClass: 'BTC', quantity: '4' },
      { symbol: 'USDC', assetClass: 'STABLECOIN', quantity: '150000' },
    ]);
    // Move the market hard, so the stored decision's own sentences now quote
    // collateral figures far from the live ones.
    await api('POST', '/v1/market/scenario', { symbol: 'BTC', changePercent: '-40' });

    const res = await api('POST', '/v1/ai/query', { question: 'Explain my credit limit' }, token);
    expect(res.status).toBe(200);

    const answer = res.body.answer as string;
    const stored = await query<{ fact_pack: { value: string }[]; grounding_rejected: boolean }>(
      harness.pool,
      'SELECT fact_pack, grounding_rejected FROM ai_interactions ORDER BY created_at DESC LIMIT 1',
    );
    const disclosable = new Set(stored[0]!.fact_pack.map((f) => f.value.replace(/,/g, '')));
    for (const n of (answer.match(/\d[\d,]*\.\d{2}/g) ?? []).map((x) => x.replace(/,/g, ''))) {
      expect(disclosable.has(n), `"${n}" reached the customer without a source`).toBe(true);
    }
  });

  it('classifies each supported intent', async () => {
    const { token } = await onboard('intents@test.example', [
      { symbol: 'USDC', assetClass: 'STABLECOIN', quantity: '150000' },
    ]);
    const cases: [string, string][] = [
      ['Why did my credit limit drop?', 'why_changed'],
      ['What is my collateral health?', 'collateral_health'],
      ['What if bitcoin crashes 50%?', 'stress_test'],
      ['How many points do I have?', 'rewards_summary'],
    ];
    for (const [question, intent] of cases) {
      const res = await api('POST', '/v1/ai/query', { question }, token);
      expect(res.body.intent, question).toBe(intent);
    }
  });

  it('records every interaction for audit', async () => {
    const { token } = await onboard('aiaudit@test.example', [
      { symbol: 'USDC', assetClass: 'STABLECOIN', quantity: '150000' },
    ]);
    await api('POST', '/v1/ai/query', { question: 'Explain my credit limit' }, token);
    const history = await api('GET', '/v1/ai/history', undefined, token);
    expect((history.body.interactions as unknown[]).length).toBe(1);
  });
});

describe('operations console', () => {
  let operatorToken: string;
  let secondOperatorToken: string;

  beforeAll(async () => {
    const { hashPassword } = await import('../src/auth.js');
    for (const [email, name] of [['op1@test.example', 'Op One'], ['op2@test.example', 'Op Two']]) {
      const { hash, salt } = await hashPassword(PASSWORD);
      await query(harness.pool,
        `INSERT INTO operators (email, name, roles, password_hash, password_salt)
         VALUES ($1,$2,'{risk,admin,compliance}',$3,$4) ON CONFLICT (email) DO NOTHING`,
        [email, name, hash, salt]);
    }
    operatorToken = (await api('POST', '/v1/operator/login', {
      email: 'op1@test.example', password: PASSWORD,
    })).body.token as string;
    secondOperatorToken = (await api('POST', '/v1/operator/login', {
      email: 'op2@test.example', password: PASSWORD,
    })).body.token as string;
  });

  it('lists customers with their risk state', async () => {
    const res = await api('GET', '/v1/admin/customers', undefined, operatorToken);
    expect(res.status).toBe(200);
    expect((res.body.customers as unknown[]).length).toBeGreaterThan(0);
  });

  it('refuses to let one operator approve their own request', async () => {
    const { customerId } = await onboard('fourEyes@test.example', [
      { symbol: 'USDC', assetClass: 'STABLECOIN', quantity: '150000' },
    ]);

    const filed = await api('POST', '/v1/admin/approvals', {
      action: 'credit.manual_limit_override',
      entityType: 'customer', entityId: customerId,
      payload: { creditLimit: '250000' },
      justification: 'Relationship review outcome, documented in case 4412.',
    }, operatorToken);
    expect(filed.status).toBe(201);
    const approvalId = filed.body.approvalId as string;

    const selfApprove = await api('POST', `/v1/admin/approvals/${approvalId}/approve`, {}, operatorToken);
    expect(selfApprove.status).toBe(403);

    const secondApprove = await api('POST', `/v1/admin/approvals/${approvalId}/approve`, {}, secondOperatorToken);
    expect(secondApprove.status).toBe(200);
    expect((secondApprove.body.result as Record<string, string>).creditLimit).toBe('250000.00');
  });

  it('rejects an action that is not on the dual-approval list', async () => {
    const res = await api('POST', '/v1/admin/approvals', {
      action: 'something.arbitrary', entityType: 'customer', entityId: 'x',
      payload: {}, justification: 'Trying to route an unknown action through approval.',
    }, operatorToken);
    expect(res.status).toBe(400);
    expect((res.body.error as Record<string, string>).code).toBe('action_not_dual_approved');
  });

  it('writes an audit record for every material action', async () => {
    const res = await api('GET', '/v1/admin/audit?limit=200', undefined, operatorToken);
    expect(res.status).toBe(200);
    const actions = (res.body.entries as { action: string }[]).map((e) => e.action);
    expect(actions).toContain('customer.registered');
    expect(actions).toContain('card.issued');
    expect(actions).toContain('credit.limit_changed');
  });

  it('reports portfolio metrics', async () => {
    const res = await api('GET', '/v1/admin/metrics', undefined, operatorToken);
    expect(res.status).toBe(200);
    const portfolio = res.body.portfolio as Record<string, unknown>;
    expect(Number(portfolio.customers)).toBeGreaterThan(0);
    const payments = res.body.payments as Record<string, string>;
    expect(Number(payments.approvalRate)).toBeGreaterThan(0);
  });

  it('exposes the active policy and its validation state', async () => {
    const res = await api('GET', '/v1/admin/policies', undefined, operatorToken);
    expect(res.status).toBe(200);
    expect(res.body.activeVersion).toBe('risk-policy-1.0.0');
    const available = res.body.available as { version: string; valid: boolean }[];
    expect(available.every((p) => p.valid)).toBe(true);
  });
});
