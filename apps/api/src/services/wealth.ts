/**
 * Wealth graph service (PRD §9) and valuation (PRD §19.1).
 *
 * Syncs holdings from the custodian, consolidates prices across feeds, and
 * hands the domain core everything it needs to compute collateral. The core
 * stays pure; all the I/O lives here.
 */
import {
  computeCollateral, consolidate, D, Decimal, getPolicy, Money, realizedVolatility,
  resolveAssetPolicy, valuePortfolio,
  type AssetHolding, type CollateralSummary, type ConsolidatedPrice, type Jurisdiction,
  type PriceQuote, type ValuationContext,
} from '@wealthcard/core';
import { query, type Db } from '../db.js';
import { notFound } from '../errors.js';
import type { AppContext } from '../context.js';

interface AssetRow {
  id: string;
  customer_id: string;
  asset_class: AssetHolding['assetClass'];
  symbol: string;
  custodian: string;
  custody_model: AssetHolding['custodyModel'];
  quantity: string;
  quote_currency: string;
  verification: AssetHolding['verification'];
  last_verified_at: Date;
  pledged: boolean;
  excluded: boolean;
  excluded_reason: string | null;
}

export const loadHoldings = async (db: Db, customerId: string): Promise<AssetHolding[]> => {
  const rows = await query<AssetRow>(
    db, `SELECT * FROM assets WHERE customer_id = $1 ORDER BY symbol`, [customerId],
  );
  return rows.map((r) => ({
    assetId: r.id,
    customerId: r.customer_id,
    assetClass: r.asset_class,
    symbol: r.symbol,
    custodian: r.custodian,
    custodyModel: r.custody_model,
    quantity: D(r.quantity),
    quoteCurrency: r.quote_currency,
    verification: r.verification,
    lastVerifiedAt: r.last_verified_at,
    pledged: r.pledged,
    excluded: r.excluded,
    ...(r.excluded_reason ? { excludedReason: r.excluded_reason } : {}),
  }));
};

/**
 * Consolidate a price per symbol across every configured feed.
 *
 * Feeds are queried in parallel and a failing feed is dropped rather than
 * failing the whole valuation: the consolidator already knows how to express
 * "too few sources" as `disputed`, which downstream engines handle safely.
 *
 * Staleness tolerance comes from the asset class actually being priced — BTC
 * gets 120 seconds, an ETF gets 15 minutes. Applying one global tolerance
 * would either suspend equities constantly or let a stale BTC mark through.
 */
export const consolidatePrices = async (
  ctx: AppContext,
  symbols: readonly { symbol: string; assetClass: AssetHolding['assetClass'] }[],
): Promise<Map<string, ConsolidatedPrice>> => {
  const policy = getPolicy();

  const classBySymbol = new Map<string, AssetHolding['assetClass']>();
  for (const s of symbols) classBySymbol.set(s.symbol.toUpperCase(), s.assetClass);
  const wanted = [...classBySymbol.keys()];
  if (wanted.length === 0) return new Map();

  const results = await Promise.allSettled(
    ctx.partners.marketData.map((provider) => provider.quotes(wanted)),
  );

  const bySymbol = new Map<string, PriceQuote[]>();
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    for (const quote of result.value) {
      const list = bySymbol.get(quote.symbol) ?? [];
      list.push(quote);
      bySymbol.set(quote.symbol, list);
    }
  }

  const now = ctx.now();
  const out = new Map<string, ConsolidatedPrice>();
  for (const [symbol, quotes] of bySymbol) {
    if (quotes.length === 0) continue;
    const assetClass = classBySymbol.get(symbol);
    if (!assetClass) continue;
    const assetPolicy = resolveAssetPolicy(policy, assetClass, symbol);
    out.set(symbol, consolidate(quotes, {
      now,
      maxAgeSeconds: assetPolicy.maxPriceAgeSeconds,
      minSources: 2,
    }));
  }
  return out;
};

/** Realized volatility per symbol, so haircuts track the market. */
export const loadVolatility = async (
  ctx: AppContext, symbols: readonly string[],
): Promise<Map<string, Decimal>> => {
  const out = new Map<string, Decimal>();
  const provider = ctx.partners.marketData[0];
  if (!provider) return out;
  await Promise.all(symbols.map(async (symbol) => {
    try {
      const history = await provider.history(symbol, 30);
      const vol = realizedVolatility(history);
      if (vol) out.set(symbol.toUpperCase(), vol);
    } catch {
      // No history is not an error: the policy default volatility applies.
    }
  }));
  return out;
};

export const buildValuationContext = async (
  ctx: AppContext, holdings: readonly AssetHolding[],
): Promise<ValuationContext> => {
  const policy = getPolicy();
  const prices = await consolidatePrices(
    ctx, holdings.map((h) => ({ symbol: h.symbol, assetClass: h.assetClass })),
  );

  const currencies = [...new Set(holdings.map((h) => h.quoteCurrency.toUpperCase()))]
    .filter((c) => c !== policy.facilityCurrency);
  let fx = new Map<string, Decimal>();
  if (currencies.length > 0 && ctx.partners.marketData[0]) {
    try {
      fx = await ctx.partners.marketData[0].fxRates('USD', currencies);
    } catch {
      fx = new Map();
    }
  }

  return { prices, fx, facilityCurrency: policy.facilityCurrency, now: ctx.now() };
};

export interface WealthView {
  readonly holdings: readonly AssetHolding[];
  readonly collateral: CollateralSummary;
  readonly unpricedSymbols: readonly string[];
}

/** The customer's full wealth picture, valued and scored for collateral. */
export const computeWealth = async (
  ctx: AppContext, db: Db, customerId: string, jurisdiction: Jurisdiction,
): Promise<WealthView> => {
  const policy = getPolicy();
  const holdings = await loadHoldings(db, customerId);
  const valuationCtx = await buildValuationContext(ctx, holdings);
  const { valued, unpriced } = valuePortfolio(holdings, valuationCtx);
  const volatilityBySymbol = await loadVolatility(ctx, holdings.map((h) => h.symbol));

  const collateral = computeCollateral({
    customerId, jurisdiction, valued, volatilityBySymbol, policy, now: ctx.now(),
  });

  return { holdings, collateral, unpricedSymbols: unpriced.map((h) => h.symbol) };
};

/** Persist the observed prices so a past valuation can be reproduced. */
export const recordPrices = async (
  db: Db, prices: ReadonlyMap<string, ConsolidatedPrice>,
): Promise<void> => {
  for (const price of prices.values()) {
    await query(
      db,
      `INSERT INTO price_observations (symbol, currency, price, source, as_of)
       VALUES ($1,$2,$3,$4,$5)`,
      [price.symbol, price.currency, price.price.toFixed(), price.sources.join('+'), price.asOf],
    );
  }
};

/**
 * Pull balances from the custodian into the wealth graph.
 *
 * Quantities are replaced, never accumulated: the custodian is the source of
 * truth for what is actually held, and a customer who withdraws must see that
 * reflected in their collateral immediately.
 */
export const syncFromCustody = async (
  ctx: AppContext, db: Db, customerId: string, custodyAccountId: string,
): Promise<{ synced: number }> => {
  const balances = await ctx.partners.custody.listBalances(custodyAccountId);
  const now = ctx.now();
  let synced = 0;

  for (const balance of balances) {
    await query(
      db,
      `INSERT INTO assets
         (customer_id, asset_class, symbol, custodian, custody_model, quantity,
          verification, last_verified_at, pledged)
       VALUES ($1,$2,$3,$4,'institutional_custodian',$5,'custodian_api',$6,
               COALESCE((SELECT pledged FROM assets WHERE customer_id=$1 AND custodian=$4 AND symbol=$3), FALSE))
       ON CONFLICT (customer_id, custodian, symbol) DO UPDATE
         SET quantity = EXCLUDED.quantity,
             last_verified_at = EXCLUDED.last_verified_at,
             updated_at = now()`,
      [customerId, balance.assetClass, balance.symbol, ctx.partners.custody.name, balance.quantity.toFixed(), now],
    );
    synced += 1;
  }

  await query(
    db, `UPDATE connected_accounts SET last_synced_at = $2 WHERE customer_id = $1`, [customerId, now],
  );
  return { synced };
};

export const requireCustomerRow = async <T extends Record<string, unknown>>(
  db: Db, customerId: string,
): Promise<T> => {
  const rows = await query<T & Record<string, unknown>>(
    db, 'SELECT * FROM customers WHERE id = $1', [customerId],
  );
  const row = rows[0];
  if (!row) throw notFound('Customer');
  return row as T;
};

export { Money };
