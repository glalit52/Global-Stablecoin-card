/**
 * Payments: authorization, settlement, refunds and repayment.
 *
 * The authorization path is the one place in this system with a hard latency
 * budget, so it does the minimum: one transaction, one facility row lock, the
 * pure decision function, one insert. Collateral is *not* revalued here — the
 * risk loop keeps a current snapshot precisely so that a card tap never has to
 * wait on three price feeds.
 */
import type pg from 'pg';
import {
  authorize, cardRefundEntry, cardSettlementEntry, categoryForMcc, computeEarn, D, Decimal,
  Decimal as DecimalCtor, fxRevenueEntry, getPolicy, interchangeEntry, Money, repaymentEntry,
  rewardsAccrualEntry, tierPolicy, totalDebt,
  type AuthorizationDecision, type AuthorizationRequest, type Card, type CardControls,
  type FraudContext, type MerchantCategory, type RecentTransaction, type Tier,
} from '@wealthcard/core';
import { lockFacility, money, query, queryOne, toNumeric, toNumericOrNull, type Db } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { audit } from '../audit.js';
import type { AppContext } from '../context.js';
import { loadCustomer, loadFacility } from './credit.js';
import { postEntry, syncFacilityFromLedger, syncHolds } from './ledger.js';
import { previousSnapshot } from './risk.js';

/** Interchange we expect to earn, by category. Basis points of billing amount. */
const INTERCHANGE_BPS: Partial<Record<MerchantCategory, number>> = {
  groceries: 110, fuel_ev: 115, dining: 185, travel: 185, hotels: 185, lounges: 185,
  retail: 165, ecommerce: 180, subscriptions: 170, utilities: 75, transit: 140,
  cash_advance: 0, crypto: 0, gambling: 0, other: 160,
};

export const expectedInterchange = (amount: Money, category: MerchantCategory): Money =>
  amount.times(D(INTERCHANGE_BPS[category] ?? 160).dividedBy(10_000)).round();

const parseControls = (raw: unknown, currency: string): CardControls => {
  const c = (raw ?? {}) as Record<string, unknown>;
  const asMoney = (v: unknown) => (typeof v === 'string' && v.length > 0 ? money(v, currency) : null);
  return {
    blockedMccs: (c.blockedMccs as string[]) ?? [],
    allowedCountries: (c.allowedCountries as string[]) ?? [],
    blockedCountries: (c.blockedCountries as string[]) ?? [],
    atmEnabled: c.atmEnabled !== false,
    onlineEnabled: c.onlineEnabled !== false,
    contactlessEnabled: c.contactlessEnabled !== false,
    internationalEnabled: c.internationalEnabled !== false,
    perTransactionLimit: asMoney(c.perTransactionLimit),
    dailyLimit: asMoney(c.dailyLimit),
    monthlyLimit: asMoney(c.monthlyLimit),
  };
};

export const loadCard = async (db: Db, cardId: string, currency = 'USD'): Promise<Card & { partnerCardId: string }> => {
  const row = await queryOne<{
    id: string; customer_id: string; partner_card_id: string; network: string;
    form: Card['form']; last4: string; exp_month: number; exp_year: number;
    status: Card['status']; controls: unknown; wallets: string[];
  }>(db, 'SELECT * FROM cards WHERE id = $1', [cardId]);
  if (!row) throw notFound('Card');
  return {
    cardId: row.id,
    customerId: row.customer_id,
    partnerCardId: row.partner_card_id,
    network: row.network as Card['network'],
    form: row.form,
    last4: row.last4,
    expMonth: row.exp_month,
    expYear: row.exp_year,
    status: row.status,
    controls: parseControls(row.controls, currency),
    walletProvisioned: row.wallets as Card['walletProvisioned'],
  };
};

/** Recent activity the fraud engine scores against. */
const buildFraudContext = async (
  db: Db, customerId: string, now: Date, travelNotice: string[],
): Promise<FraudContext> => {
  const policy = getPolicy();
  const rows = await query<{
    billing_amount: string; decided_at: Date; merchant_country: string; approved: boolean;
  }>(
    db,
    `SELECT billing_amount::text, decided_at, merchant_country, approved
       FROM authorizations WHERE customer_id = $1 AND decided_at > $2
       ORDER BY decided_at DESC LIMIT 100`,
    [customerId, new Date(now.getTime() - 24 * 3_600_000)],
  );

  const recent: RecentTransaction[] = rows.map((r) => ({
    amount: money(r.billing_amount),
    at: r.decided_at,
    merchantCountry: r.merchant_country,
    declined: !r.approved,
  }));

  const avg = await queryOne<{ avg: string | null }>(
    db,
    `SELECT AVG(billing_amount)::text AS avg FROM authorizations
      WHERE customer_id = $1 AND approved AND decided_at > $2`,
    [customerId, new Date(now.getTime() - 90 * 86_400_000)],
  );

  const countries = await query<{ merchant_country: string }>(
    db,
    `SELECT DISTINCT merchant_country FROM authorizations WHERE customer_id = $1 AND approved`,
    [customerId],
  );

  const devices = await query<{ id: string }>(
    db, 'SELECT id FROM devices WHERE customer_id = $1 AND revoked_at IS NULL', [customerId],
  );

  const account = await queryOne<{ created_at: Date }>(
    db, 'SELECT created_at FROM customers WHERE id = $1', [customerId],
  );

  return {
    recent,
    averageTicket: avg?.avg ? money(avg.avg) : null,
    knownCountries: new Set(countries.map((c) => c.merchant_country.toUpperCase())),
    knownDevices: new Set(devices.map((d) => d.id)),
    accountAgeDays: account
      ? Math.floor((now.getTime() - account.created_at.getTime()) / 86_400_000) : 0,
    travelNoticeCountries: new Set(travelNotice.map((c) => c.toUpperCase())),
    policy,
    now,
  };
};

export interface AuthorizeInput {
  readonly requestId: string;
  readonly cardId: string;
  readonly amount: string;
  readonly currency: string;
  readonly merchantId: string;
  readonly merchantName: string;
  readonly mcc: string;
  readonly merchantCountry: string;
  readonly entryMode: AuthorizationRequest['entryMode'];
  readonly isRecurring?: boolean;
  readonly deviceId?: string;
  readonly geo?: { lat: number; lon: number };
}

/**
 * Decide a card authorization and, when approved, place the hold.
 *
 * The whole thing runs in one transaction under a facility row lock. Without
 * that lock two taps arriving together would both read the same available
 * credit and both approve, and the customer would be over limit through no
 * fault of their own.
 */
export const authorizeTransaction = async (
  ctx: AppContext, pool: pg.Pool, input: AuthorizeInput,
): Promise<AuthorizationDecision> => {
  const policy = getPolicy();
  const now = ctx.now();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const existing = await queryOne<{ id: string }>(
      client, 'SELECT id FROM authorizations WHERE request_id = $1', [input.requestId],
    );
    if (existing) {
      // A network retry. Return the original decision verbatim.
      await client.query('COMMIT');
      const stored = await loadAuthorization(pool, input.requestId);
      if (stored) return stored;
      throw conflict('duplicate_request', 'Authorization already recorded');
    }

    const card = await loadCard(client, input.cardId);
    const customer = await loadCustomer(client, card.customerId);
    await lockFacility(client, card.customerId);
    const facility = await loadFacility(client, card.customerId);

    const snapshot = await previousSnapshot(client, card.customerId);
    if (!snapshot) {
      // No risk snapshot means we cannot know the collateral position. The
      // safe answer is to decline, not to assume the account is healthy.
      await client.query('ROLLBACK');
      throw conflict('no_risk_snapshot', 'No current risk snapshot for this account');
    }

    const amount = Money.of(input.amount, input.currency);
    const request: AuthorizationRequest = {
      requestId: input.requestId,
      cardId: input.cardId,
      amount,
      merchantId: input.merchantId,
      merchantName: input.merchantName,
      mcc: input.mcc,
      merchantCountry: input.merchantCountry,
      entryMode: input.entryMode,
      isRecurring: input.isRecurring ?? false,
      requestedAt: now,
      ...(input.deviceId ? { deviceId: input.deviceId } : {}),
      ...(input.geo ? { geo: input.geo } : {}),
    };

    let fxRate: Decimal | null = null;
    if (input.currency.toUpperCase() !== facility.currency) {
      fxRate = ctx.market.fxRate(input.currency) ?? null;
    }

    const windows = await queryOne<{ today: string; month: string }>(
      client,
      `SELECT
         COALESCE(SUM(billing_amount) FILTER (WHERE decided_at >= date_trunc('day', $2::timestamptz)),0)::text AS today,
         COALESCE(SUM(billing_amount) FILTER (WHERE decided_at >= date_trunc('month', $2::timestamptz)),0)::text AS month
       FROM authorizations WHERE customer_id = $1 AND approved`,
      [card.customerId, now],
    );

    const stepUp = await queryOne<{ ok: boolean }>(
      client,
      `SELECT (step_up_until IS NOT NULL AND step_up_until > now()) AS ok
         FROM sessions WHERE customer_id = $1 AND revoked_at IS NULL
         ORDER BY created_at DESC LIMIT 1`,
      [card.customerId],
    );

    const decision = authorize(request, {
      card,
      facility,
      risk: snapshot,
      tier: customer.tier,
      fraud: await buildFraudContext(client, card.customerId, now, []),
      fxRate,
      spentToday: money(windows?.today ?? '0', facility.currency),
      spentThisMonth: money(windows?.month ?? '0', facility.currency),
      stepUpSatisfied: stepUp?.ok ?? false,
      policy,
      now,
    });

    const authRow = await queryOne<{ id: string }>(
      client,
      `INSERT INTO authorizations
         (request_id, customer_id, card_id, approved, original_amount, original_currency,
          billing_amount, fx_rate, fx_fee, merchant_name, merchant_id, mcc, merchant_country,
          entry_mode, is_recurring, decline_code, decline_reason, fraud_score, checks,
          latency_ms, policy_version, decided_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
       RETURNING id`,
      [
        input.requestId, card.customerId, card.cardId, decision.approved,
        toNumeric(amount), amount.currency, toNumeric(decision.billingAmount),
        toNumericOrNull(decision.fxRate), toNumeric(decision.fxFee),
        input.merchantName, input.merchantId, input.mcc, input.merchantCountry.toUpperCase(),
        input.entryMode, input.isRecurring ?? false,
        decision.declineCode, decision.declineReason,
        decision.fraudScore.toDecimalPlaces(4).toFixed(),
        JSON.stringify(decision.checks),
        decision.latencyMs, policy.version, now,
        decision.approved ? new Date(now.getTime() + ctx.config.authHoldTtlSeconds * 1000) : null,
      ],
    );

    if (decision.approved) await syncHolds(client, card.customerId, facility.currency);

    await audit(client, {
      actorType: 'system', actorId: 'authorization_engine',
      action: decision.approved ? 'card.authorized' : 'card.declined',
      entityType: 'authorization', entityId: authRow!.id,
      after: {
        approved: decision.approved,
        billingAmount: decision.billingAmount.toFixedString(),
        declineCode: decision.declineCode,
        merchant: input.merchantName,
        fraudScore: decision.fraudScore.toFixed(),
      },
      policyVersion: policy.version,
      correlationId: input.requestId,
    });

    await client.query('COMMIT');
    return decision;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already gone */ }
    throw err;
  } finally {
    client.release();
  }
};

export const loadAuthorization = async (
  db: Db, requestId: string,
): Promise<AuthorizationDecision | null> => {
  const row = await queryOne<{
    id: string; approved: boolean; billing_amount: string; fx_rate: string | null;
    fx_fee: string; decline_code: string | null; decline_reason: string | null;
    checks: AuthorizationDecision['checks']; fraud_score: string; decided_at: Date;
    latency_ms: number; customer_id: string;
  }>(db, 'SELECT * FROM authorizations WHERE request_id = $1', [requestId]);
  if (!row) return null;

  const facility = await queryOne<{ credit_limit: string; principal_balance: string;
    interest_balance: string; fee_balance: string; holds_total: string; currency: string }>(
    db, 'SELECT * FROM credit_facilities WHERE customer_id = $1', [row.customer_id],
  );
  const currency = facility?.currency ?? 'USD';
  const available = facility
    ? money(facility.credit_limit, currency)
        .minus(money(facility.principal_balance, currency))
        .minus(money(facility.interest_balance, currency))
        .minus(money(facility.fee_balance, currency))
        .minus(money(facility.holds_total, currency))
        .clampPositive()
    : Money.zero(currency);

  return {
    requestId,
    approved: row.approved,
    authorizationId: row.approved ? `auth_${requestId}` : null,
    billingAmount: money(row.billing_amount, currency),
    fxRate: row.fx_rate === null ? null : D(row.fx_rate),
    fxFee: money(row.fx_fee, currency),
    declineCode: row.decline_code as AuthorizationDecision['declineCode'],
    declineReason: row.decline_reason,
    checks: row.checks,
    fraudScore: D(row.fraud_score),
    availableCreditAfter: available,
    decidedAt: row.decided_at,
    latencyMs: row.latency_ms,
  };
};

/**
 * Settle an approved authorization.
 *
 * Releases the hold, posts the purchase, interchange, FX margin and rewards to
 * the ledger, then rebuilds the facility balances from the postings. Every
 * journal entry carries an idempotency key derived from the authorization, so
 * a duplicate settlement webhook posts nothing.
 */
export const settleAuthorization = async (
  ctx: AppContext, pool: pg.Pool, requestId: string, settledAmount?: string,
): Promise<{ transactionId: string; points: string; duplicate: boolean }> => {
  const policy = getPolicy();
  const now = ctx.now();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const auth = await queryOne<{
      id: string; customer_id: string; card_id: string; approved: boolean;
      billing_amount: string; original_amount: string; original_currency: string;
      fx_rate: string | null; fx_fee: string; merchant_name: string; mcc: string;
      merchant_country: string; hold_released: boolean;
    }>(client, 'SELECT * FROM authorizations WHERE request_id = $1 FOR UPDATE', [requestId]);

    if (!auth) throw notFound('Authorization');
    if (!auth.approved) throw badRequest('authorization_declined', 'A declined authorization cannot settle');

    const existingTx = await queryOne<{ id: string; points_earned: string }>(
      client, 'SELECT id, points_earned::text FROM transactions WHERE authorization_id = $1', [auth.id],
    );
    if (existingTx) {
      await client.query('COMMIT');
      return { transactionId: existingTx.id, points: existingTx.points_earned, duplicate: true };
    }

    await lockFacility(client, auth.customer_id);
    const customer = await loadCustomer(client, auth.customer_id);
    const facility = await loadFacility(client, auth.customer_id);
    const currency = facility.currency;

    // A merchant may settle for less than they authorized (a tip removed, an
    // item out of stock). Never for more: that needs a new authorization.
    const authorized = money(auth.billing_amount, currency);
    const settled = settledAmount ? money(settledAmount, currency).min(authorized) : authorized;
    const category = categoryForMcc(auth.mcc);

    const txRow = await queryOne<{ id: string }>(
      client,
      `INSERT INTO transactions
         (customer_id, card_id, authorization_id, status, merchant_name, mcc, category,
          merchant_country, original_amount, original_currency, billing_amount, fx_rate,
          fx_fee, interchange, authorized_at, settled_at)
       VALUES ($1,$2,$3,'settled',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING id`,
      [
        auth.customer_id, auth.card_id, auth.id, auth.merchant_name, auth.mcc, category,
        auth.merchant_country, auth.original_amount, auth.original_currency,
        toNumeric(settled), auth.fx_rate, auth.fx_fee,
        toNumeric(expectedInterchange(settled, category)), now, now,
      ],
    );
    const transactionId = txRow!.id;

    const fxFee = money(auth.fx_fee, currency);
    // The FX margin is booked as its own revenue entry, so the purchase line
    // the customer sees is the merchant's amount, not a blended figure.
    const principalPortion = settled.minus(fxFee).clampPositive();

    await postEntry(client, cardSettlementEntry(
      { entryId: transactionId, occurredAt: now, idempotencyKey: `settle:${auth.id}` },
      auth.customer_id, transactionId, principalPortion, auth.merchant_name,
    ));

    if (fxFee.isPositive()) {
      await postEntry(client, fxRevenueEntry(
        { entryId: `${transactionId}:fx`, occurredAt: now, idempotencyKey: `fx:${auth.id}` },
        auth.customer_id, transactionId, fxFee,
      ));
    }

    const interchange = expectedInterchange(settled, category);
    if (interchange.isPositive()) {
      await postEntry(client, interchangeEntry(
        { entryId: `${transactionId}:ic`, occurredAt: now, idempotencyKey: `interchange:${auth.id}` },
        transactionId, interchange,
      ));
    }

    // Rewards
    const bonusSpend = await queryOne<{ total: string }>(
      client,
      `SELECT COALESCE(SUM(billing_amount),0)::text AS total FROM transactions
        WHERE customer_id = $1 AND settled_at >= date_trunc('month', $2::timestamptz)
          AND category = ANY($3)`,
      [auth.customer_id, now, Object.keys(tierPolicy(policy, customer.tier).categoryMultipliers)],
    );

    const earn = computeEarn({
      tier: customer.tier,
      category,
      billingAmount: settled,
      bonusSpendThisMonth: money(bonusSpend?.total ?? '0', currency),
      policy,
    });

    if (!earn.points.isZero()) {
      await query(
        client,
        `INSERT INTO reward_entries
           (customer_id, type, points, transaction_id, category, rate_applied, accrual_cost, description, occurred_at)
         VALUES ($1,'earn_posted',$2,$3,$4,$5,$6,$7,$8)`,
        [auth.customer_id, earn.points.toFixed(), transactionId, category,
         earn.effectiveRate.toDecimalPlaces(4).toFixed(), toNumeric(earn.accrualCost),
         earn.explanation, now],
      );
      await query(
        client, 'UPDATE transactions SET points_earned = $2 WHERE id = $1',
        [transactionId, earn.points.toFixed()],
      );
      await postEntry(client, rewardsAccrualEntry(
        { entryId: `${transactionId}:rw`, occurredAt: now, idempotencyKey: `rewards:${auth.id}` },
        transactionId, earn.accrualCost, earn.points.toFixed(),
      ));
    }

    await query(client, 'UPDATE authorizations SET hold_released = TRUE WHERE id = $1', [auth.id]);
    await syncHolds(client, auth.customer_id, currency);
    await syncFacilityFromLedger(client, auth.customer_id, currency);

    await audit(client, {
      actorType: 'partner', actorId: 'card_processor',
      action: 'card.settled',
      entityType: 'transaction', entityId: transactionId,
      after: {
        billingAmount: settled.toFixedString(),
        interchange: interchange.toFixedString(),
        points: earn.points.toFixed(),
      },
      policyVersion: policy.version,
      correlationId: requestId,
    });

    await client.query('COMMIT');
    return { transactionId, points: earn.points.toFixed(), duplicate: false };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already gone */ }
    throw err;
  } finally {
    client.release();
  }
};

/** Release an approved hold that never settled. */
export const expireHold = async (
  ctx: AppContext, pool: pg.Pool, requestId: string,
): Promise<void> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const auth = await queryOne<{ id: string; customer_id: string }>(
      client,
      `SELECT id, customer_id FROM authorizations
        WHERE request_id = $1 AND approved AND NOT hold_released FOR UPDATE`,
      [requestId],
    );
    if (auth) {
      await lockFacility(client, auth.customer_id);
      await query(client, 'UPDATE authorizations SET hold_released = TRUE WHERE id = $1', [auth.id]);
      await syncHolds(client, auth.customer_id);
    }
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already gone */ }
    throw err;
  } finally {
    client.release();
  }
};

export const refundTransaction = async (
  ctx: AppContext, pool: pg.Pool, transactionId: string, amount?: string,
): Promise<{ refunded: string }> => {
  const now = ctx.now();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tx = await queryOne<{
      id: string; customer_id: string; billing_amount: string; merchant_name: string;
      status: string; points_earned: string; category: string;
    }>(client, 'SELECT * FROM transactions WHERE id = $1 FOR UPDATE', [transactionId]);
    if (!tx) throw notFound('Transaction');
    if (tx.status === 'refunded') throw conflict('already_refunded', 'Transaction has already been refunded');

    await lockFacility(client, tx.customer_id);
    const facility = await loadFacility(client, tx.customer_id);
    const full = money(tx.billing_amount, facility.currency);
    const refund = amount ? money(amount, facility.currency).min(full) : full;

    await postEntry(client, cardRefundEntry(
      { entryId: `${transactionId}:refund`, occurredAt: now, idempotencyKey: `refund:${transactionId}:${refund.toString()}` },
      tx.customer_id, transactionId, refund, tx.merchant_name, false,
    ));

    // Points earned on a refunded purchase are clawed back proportionally.
    const points = D(tx.points_earned);
    if (points.gt(0) && full.isPositive()) {
      // Round the clawback up: a partial refund should not leave the customer
      // holding a fractional point's worth of value they did not keep.
      const clawback = points
        .times(refund.amount.dividedBy(full.amount))
        .toDecimalPlaces(0, DecimalCtor.ROUND_CEIL);
      await query(
        client,
        `INSERT INTO reward_entries (customer_id, type, points, transaction_id, description, occurred_at)
         VALUES ($1,'reversal',$2,$3,$4,$5)`,
        [tx.customer_id, clawback.toFixed(), transactionId, 'Points reversed on refund', now],
      );
    }

    await query(
      client, `UPDATE transactions SET status = $2 WHERE id = $1`,
      [transactionId, refund.eq(full) ? 'refunded' : 'settled'],
    );
    await syncFacilityFromLedger(client, tx.customer_id, facility.currency);

    await audit(client, {
      actorType: 'partner', actorId: 'card_processor',
      action: 'card.refunded', entityType: 'transaction', entityId: transactionId,
      after: { amount: refund.toFixedString() },
    });

    await client.query('COMMIT');
    return { refunded: refund.toFixedString() };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already gone */ }
    throw err;
  } finally {
    client.release();
  }
};

/**
 * Apply a customer repayment.
 *
 * Application order is fees, then interest, then principal — the order the
 * ledger helper enforces — and anything above the balance is held as a credit
 * balance rather than driving a receivable negative.
 */
export const applyRepayment = async (
  ctx: AppContext, pool: pg.Pool, customerId: string,
  amountRaw: string, source: 'fiat' | 'stablecoin' | 'liquidation',
  idempotencyKey: string, externalRef?: string,
): Promise<{ repaymentId: string; applied: Record<string, string>; duplicate: boolean }> => {
  const now = ctx.now();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const existing = await queryOne<{ id: string; applied_to_fees: string; applied_to_interest: string;
      applied_to_principal: string; overpayment: string }>(
      client, 'SELECT * FROM repayments WHERE external_ref = $1', [idempotencyKey],
    );
    if (existing) {
      await client.query('COMMIT');
      return {
        repaymentId: existing.id,
        applied: {
          fees: money(existing.applied_to_fees).toFixedString(),
          interest: money(existing.applied_to_interest).toFixedString(),
          principal: money(existing.applied_to_principal).toFixedString(),
          overpayment: money(existing.overpayment).toFixedString(),
        },
        duplicate: true,
      };
    }

    await lockFacility(client, customerId);
    const facility = await loadFacility(client, customerId);
    const currency = facility.currency;
    const amount = money(amountRaw, currency);
    if (!amount.isPositive()) throw badRequest('invalid_amount', 'Repayment must be positive');

    const outstanding = {
      fees: facility.feeBalance,
      interest: facility.interestBalance,
      principal: facility.principalBalance,
    };

    const appliedFees = amount.min(outstanding.fees);
    const afterFees = amount.minus(appliedFees);
    const appliedInterest = afterFees.min(outstanding.interest);
    const afterInterest = afterFees.minus(appliedInterest);
    const appliedPrincipal = afterInterest.min(outstanding.principal);
    const overpayment = afterInterest.minus(appliedPrincipal);

    const repayRow = await queryOne<{ id: string }>(
      client,
      `INSERT INTO repayments
         (customer_id, amount, currency, source, external_ref, applied_to_fees,
          applied_to_interest, applied_to_principal, overpayment, received_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [customerId, toNumeric(amount), currency, source, idempotencyKey,
       toNumeric(appliedFees), toNumeric(appliedInterest), toNumeric(appliedPrincipal),
       toNumeric(overpayment), now],
    );

    await postEntry(client, repaymentEntry(
      { entryId: repayRow!.id, occurredAt: now, idempotencyKey: `repayment:${idempotencyKey}` },
      customerId, repayRow!.id, amount, outstanding, source,
    ));

    await syncFacilityFromLedger(client, customerId, currency);

    await audit(client, {
      actorType: source === 'liquidation' ? 'system' : 'customer',
      actorId: customerId,
      action: 'credit.repayment_applied',
      entityType: 'repayment', entityId: repayRow!.id,
      after: {
        amount: amount.toFixedString(), source,
        fees: appliedFees.toFixedString(),
        interest: appliedInterest.toFixedString(),
        principal: appliedPrincipal.toFixedString(),
        overpayment: overpayment.toFixedString(),
      },
    });

    await client.query('COMMIT');
    return {
      repaymentId: repayRow!.id,
      applied: {
        fees: appliedFees.toFixedString(),
        interest: appliedInterest.toFixedString(),
        principal: appliedPrincipal.toFixedString(),
        overpayment: overpayment.toFixedString(),
      },
      duplicate: false,
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already gone */ }
    throw err;
  } finally {
    client.release();
  }
};

export { totalDebt };
export type { Tier };
