/**
 * Seed a demo tenant.
 *
 * Creates operators with distinct roles (so the dual-approval flow can be
 * exercised) and three customers chosen to show different parts of the risk
 * ladder: a healthy diversified book, a concentrated one, and one already
 * drawn deep enough that a modest BTC move tips it into remediation.
 */
import { createSandboxRegistry, sharedMarket } from '@wealthcard/adapters';
import { D, getPolicy, Money } from '@wealthcard/core';
import pg from 'pg';
import { hashPassword } from '../apps/api/src/auth.js';
import { createPool, query, queryOne, toNumeric, transaction } from '../apps/api/src/db.js';
import { loadConfig } from '../apps/api/src/config.js';
import { refreshCustomer } from '../apps/api/src/services/orchestrator.js';
import { issueCard } from '../apps/api/src/services/cards.js';
import { authorizeTransaction, settleAuthorization } from '../apps/api/src/services/payments.js';
import type { AppContext } from '../apps/api/src/context.js';

const DEMO_PASSWORD = 'wealth-demo-2026!';

interface SeedHolding {
  symbol: string;
  assetClass: 'BTC' | 'STABLECOIN' | 'CASH' | 'ETH' | 'EQUITY' | 'ETF';
  quantity: string;
  pledged: boolean;
}

interface SeedCustomer {
  email: string;
  legalName: string;
  jurisdiction: 'US' | 'AE' | 'SG';
  tier: 'WEALTH' | 'WEALTH_PLUS' | 'PRIVATE' | 'ULTRA';
  holdings: SeedHolding[];
  /** Spend to post after the facility opens, as a share of the credit limit. */
  drawShare: string;
  note: string;
}

const CUSTOMERS: SeedCustomer[] = [
  {
    email: 'ana@example.com',
    legalName: 'Ana Fitzgerald',
    jurisdiction: 'US',
    tier: 'PRIVATE',
    holdings: [
      { symbol: 'BTC', assetClass: 'BTC', quantity: '4.5', pledged: true },
      { symbol: 'USDC', assetClass: 'STABLECOIN', quantity: '260000', pledged: true },
      { symbol: 'ETH', assetClass: 'ETH', quantity: '40', pledged: false },
    ],
    drawShare: '0.18',
    note: 'Diversified and comfortably healthy. Holds ETH, which the MVP policy does not yet accept as collateral.',
  },
  {
    email: 'devi@example.com',
    legalName: 'Devi Raman',
    jurisdiction: 'AE',
    tier: 'WEALTH_PLUS',
    holdings: [
      { symbol: 'BTC', assetClass: 'BTC', quantity: '2.2', pledged: true },
    ],
    drawShare: '0.35',
    note: 'Entirely bitcoin, so the per-asset concentration cap binds on their collateral.',
  },
  {
    email: 'marcus@example.com',
    legalName: 'Marcus Oyelaran',
    jurisdiction: 'US',
    tier: 'ULTRA',
    holdings: [
      { symbol: 'BTC', assetClass: 'BTC', quantity: '12', pledged: true },
      { symbol: 'USDC', assetClass: 'STABLECOIN', quantity: '400000', pledged: true },
      { symbol: 'PYUSD', assetClass: 'STABLECOIN', quantity: '150000', pledged: true },
    ],
    drawShare: '0.95',
    note: 'Drawn to the top of a large limit against a bitcoin-heavy book. A severe bitcoin drawdown tips this account into remediation and then liquidation.',
  },
];

/** Everyday spend, cycled through to build a believable history. */
const MERCHANTS: { name: string; mcc: string; country: string; amount: string; currency: string; entryMode: 'contactless' | 'ecommerce' | 'chip' }[] = [
  { name: 'Whole Foods Market', mcc: '5411', country: 'US', amount: '184.32', currency: 'USD', entryMode: 'contactless' },
  { name: 'Shell', mcc: '5541', country: 'US', amount: '72.10', currency: 'USD', entryMode: 'contactless' },
  { name: 'Blue Bottle Coffee', mcc: '5812', country: 'US', amount: '18.50', currency: 'USD', entryMode: 'contactless' },
  { name: 'Four Seasons George V', mcc: '7011', country: 'FR', amount: '1240.00', currency: 'EUR', entryMode: 'chip' },
  { name: 'Emirates', mcc: '3001', country: 'AE', amount: '4820.00', currency: 'USD', entryMode: 'ecommerce' },
  { name: 'Apple', mcc: '5732', country: 'US', amount: '2399.00', currency: 'USD', entryMode: 'ecommerce' },
  { name: 'Tesla Supercharger', mcc: '5552', country: 'US', amount: '31.44', currency: 'USD', entryMode: 'contactless' },
  { name: 'Trader Joe\'s', mcc: '5411', country: 'US', amount: '96.18', currency: 'USD', entryMode: 'contactless' },
  { name: 'Uber', mcc: '4121', country: 'US', amount: '27.80', currency: 'USD', entryMode: 'ecommerce' },
  { name: 'Nobu', mcc: '5812', country: 'US', amount: '412.00', currency: 'USD', entryMode: 'chip' },
];

/**
 * Occasional large purchases, sized as a share of the credit limit.
 *
 * Deliberately capped at 8% each. The fraud engine flags a ticket more than
 * eight times the trailing average, so a single enormous charge on a fresh
 * account is declined for step-up — which is correct behaviour, and means a
 * realistic history has to be built the way a real one accumulates.
 */
const LARGE_PURCHASES: { name: string; mcc: string; country: string; share: string; entryMode: 'chip' | 'ecommerce' }[] = [
  { name: "Sotheby's New York", mcc: '5999', country: 'US', share: '0.06', entryMode: 'ecommerce' },
  { name: 'Tourneau Madison Avenue', mcc: '5944', country: 'US', share: '0.07', entryMode: 'chip' },
  { name: 'NetJets', mcc: '4511', country: 'US', share: '0.08', entryMode: 'ecommerce' },
  { name: 'Four Seasons George V', mcc: '7011', country: 'FR', share: '0.05', entryMode: 'chip' },
  { name: "Christie's", mcc: '5999', country: 'US', share: '0.06', entryMode: 'ecommerce' },
  { name: 'Emirates First Class', mcc: '3001', country: 'AE', share: '0.04', entryMode: 'ecommerce' },
];

const seedOperators = async (pool: pg.Pool): Promise<void> => {
  const operators = [
    { email: 'ops@wealthcard.example', name: 'Priya Nayar', roles: ['support'] },
    { email: 'risk@wealthcard.example', name: 'Tomas Berg', roles: ['risk'] },
    { email: 'compliance@wealthcard.example', name: 'Ruth Oyelowo', roles: ['compliance'] },
    // Two admins, because a dual-approval action needs a second pair of eyes.
    { email: 'admin@wealthcard.example', name: 'Sam Achebe', roles: ['admin', 'risk', 'compliance'] },
    { email: 'admin2@wealthcard.example', name: 'Lin Zhao', roles: ['admin', 'risk', 'compliance'] },
  ];

  for (const op of operators) {
    const { hash, salt } = await hashPassword(DEMO_PASSWORD);
    await query(
      pool,
      `INSERT INTO operators (email, name, roles, password_hash, password_salt)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (email) DO NOTHING`,
      [op.email, op.name, op.roles, hash, salt],
    );
  }
  console.log(`seeded ${operators.length} operators`);
};

const run = async (): Promise<void> => {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const market = sharedMarket();
  const partners = createSandboxRegistry(market);
  // A movable clock. Seeded activity is written as if it accumulated over the
  // last 90 days, then the clock catches up to now before the final valuation.
  let seedClock = new Date(Date.now() - 90 * 86_400_000);
  const advanceClock = (ms: number) => { seedClock = new Date(seedClock.getTime() + ms); };

  const ctx: AppContext = { config, pool, partners, market, now: () => seedClock };
  const policy = getPolicy();

  try {
    const already = await queryOne<{ count: string }>(pool, 'SELECT COUNT(*)::text AS count FROM customers');
    if (Number(already?.count ?? '0') > 0) {
      console.log('customers already present — run `pnpm db:reset` first to reseed');
      return;
    }

    await seedOperators(pool);

    for (const spec of CUSTOMERS) {
      seedClock = new Date(Date.now() - 90 * 86_400_000);
      const { hash, salt } = await hashPassword(DEMO_PASSWORD);
      const custodyAccountId = `custody_${spec.email.split('@')[0]}`;

      const customerId = await transaction(pool, async (tx) => {
        const kyc = await partners.kyc.submit({
          customerId: 'pending',
          legalName: spec.legalName,
          dateOfBirth: '1986-04-11',
          email: spec.email,
          jurisdiction: spec.jurisdiction,
          addressCountry: spec.jurisdiction,
          documentType: 'passport',
          documentNumber: `P${Math.floor(Math.random() * 1e8)}`,
        }, `seed-kyc:${spec.email}`);

        const row = await queryOne<{ id: string }>(
          tx,
          `INSERT INTO customers
             (email, legal_name, date_of_birth, jurisdiction, status, tier, kyc_status,
              kyc_reference, sanctions_clear, pep_review_cleared, fraud_score,
              on_time_rate, custody_account_id, password_hash, password_salt, created_at)
           VALUES ($1,$2,'1986-04-11',$3,'active',$4,'approved',$5,TRUE,TRUE,$6,'1.0',$7,$8,$9,
                   now() - interval '2 years')
           RETURNING id`,
          [spec.email, spec.legalName, spec.jurisdiction, spec.tier, kyc.reference,
           kyc.riskScore.toDecimalPlaces(4).toFixed(), custodyAccountId, hash, salt],
        );
        const id = row!.id;

        await query(
          tx,
          `INSERT INTO connected_accounts
             (customer_id, custodian, custody_model, external_account_id, display_name, last_synced_at)
           VALUES ($1,$2,'institutional_custodian',$3,$4, now())`,
          [id, partners.custody.name, custodyAccountId, 'Institutional custody account'],
        );

        for (const h of spec.holdings) {
          await query(
            tx,
            `INSERT INTO assets
               (customer_id, asset_class, symbol, custodian, custody_model, quantity,
                verification, last_verified_at, pledged)
             VALUES ($1,$2,$3,$4,'institutional_custodian',$5,'custodian_api', now(), $6)`,
            [id, h.assetClass, h.symbol, partners.custody.name, h.quantity, h.pledged],
          );
        }
        return id;
      });

      // A registered device. Without one, every seeded charge carries the
      // unknown-device fraud signal, which stacks with the amount anomaly on a
      // large purchase and trips step-up.
      const deviceRow = await queryOne<{ id: string }>(
        pool,
        `INSERT INTO devices (customer_id, device_name, public_key, trusted, last_seen_at)
         VALUES ($1,'Seeded iPhone','seed-placeholder-key',TRUE, now()) RETURNING id`,
        [customerId],
      );
      const deviceId = deviceRow!.id;

      partners.custody.seedAccount(
        custodyAccountId,
        spec.holdings.map((h) => ({ symbol: h.symbol, assetClass: h.assetClass, quantity: h.quantity })),
      );

      // Underwrite, then issue cards.
      const refreshed = await refreshCustomer(ctx, pool, customerId, { type: 'system', id: 'seed' });
      const virtual = await issueCard(ctx, pool, customerId, 'virtual', spec.legalName.toUpperCase());
      await issueCard(ctx, pool, customerId, 'physical', spec.legalName.toUpperCase());

      const facility = await queryOne<{ credit_limit: string }>(
        pool, 'SELECT credit_limit::text FROM credit_facilities WHERE customer_id = $1', [customerId],
      );
      const limit = Money.of(facility?.credit_limit ?? '0', policy.facilityCurrency);
      const targetDraw = limit.times(D(spec.drawShare));

      // Post a spend history spread across 90 days. Advancing the clock
      // between charges keeps the velocity and amount-anomaly signals quiet,
      // which is what a genuine account looks like — and it gives the UI a
      // real history to render rather than sixty charges in one second.
      let drawn = Money.zero(policy.facilityCurrency);
      let i = 0;
      let large = 0;

      while (drawn.lt(targetDraw) && i < 270) {
        // One large purchase for every four everyday ones.
        const useLarge = i > 0 && i % 4 === 0;
        const requestId = `seed-${customerId.slice(0, 8)}-${i}`;

        const spec2 = useLarge
          ? (() => {
              const l = LARGE_PURCHASES[large % LARGE_PURCHASES.length]!;
              large += 1;
              return {
                name: l.name, mcc: l.mcc, country: l.country, entryMode: l.entryMode,
                amount: limit.times(D(l.share)).roundDown().toString(), currency: 'USD',
              };
            })()
          : (() => {
              const m = MERCHANTS[i % MERCHANTS.length]!;
              return {
                name: m.name, mcc: m.mcc, country: m.country, entryMode: m.entryMode,
                amount: m.amount, currency: m.currency,
              };
            })();

        const decision = await authorizeTransaction(ctx, pool, {
          requestId,
          cardId: virtual.cardId,
          amount: spec2.amount,
          currency: spec2.currency,
          merchantId: `m_${spec2.name.toLowerCase().replace(/\W+/g, '_')}`,
          merchantName: spec2.name,
          mcc: spec2.mcc,
          merchantCountry: spec2.country,
          entryMode: spec2.entryMode as 'contactless' | 'ecommerce' | 'chip',
          isRecurring: false,
          deviceId,
        });

        if (decision.approved) {
          await settleAuthorization(ctx, pool, requestId);
          drawn = drawn.plus(decision.billingAmount);
        }

        // Eight hours between charges, so a full run spans about 90 days.
        advanceClock(8 * 3_600_000);
        i += 1;
      }

      // Bring the clock back to the present for the closing valuation, so the
      // risk snapshot the app reads is current rather than 90 days stale.
      seedClock = new Date();
      const final = await refreshCustomer(ctx, pool, customerId, { type: 'system', id: 'seed' });

      console.log(
        `${spec.legalName.padEnd(20)} ${spec.tier.padEnd(12)} ` +
        `limit ${limit.toFixedString().padStart(12)} ` +
        `drawn ${drawn.toFixedString().padStart(11)} ` +
        `collateral ${final.wealth.collateral.eligibleCollateralValue.toFixedString().padStart(12)} ` +
        `${final.evaluation.snapshot.state} (${final.evaluation.snapshot.healthPercent.toFixed(1)}% health)`,
      );
      void refreshed;
    }

    console.log('');
    console.log('Customer logins (password for every account: ' + DEMO_PASSWORD + ')');
    for (const c of CUSTOMERS) console.log(`  ${c.email.padEnd(24)} ${c.note}`);
    console.log('');
    console.log('Operator logins:');
    console.log('  ops@wealthcard.example         support');
    console.log('  risk@wealthcard.example        risk');
    console.log('  compliance@wealthcard.example  compliance');
    console.log('  admin@wealthcard.example       admin + risk + compliance');
    console.log('  admin2@wealthcard.example      admin + risk + compliance (second approver)');
  } finally {
    await pool.end();
  }
};

run().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
