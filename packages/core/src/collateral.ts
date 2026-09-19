/**
 * Collateral engine (PRD §10).
 *
 *   Eligible Collateral Value
 *     = Market Value x Eligibility Factor x (1 - Haircut) x Liquidity Adjustment
 *
 * with a concentration adjustment layered on top so that a portfolio which is
 * really one big bet cannot borrow as if it were diversified.
 *
 * The engine is a pure function of (holdings, prices, policy, clock). Same
 * inputs, same output, every time — that is what makes it auditable, and it
 * is why nothing in here reads a clock or a database of its own.
 */
import { clamp, D, Decimal, Money, ONE, ZERO } from './money.js';
import { resolveAssetPolicy, type RiskPolicy } from './policy.js';
import { isDepegged, isPriceStaleFor } from './valuation.js';
import type {
  AssetClass, CollateralPosition, CollateralSummary, IneligibilityReason,
  Jurisdiction, StressScenario, ValuedAsset,
} from './types.js';

export interface CollateralInputs {
  readonly customerId: string;
  readonly jurisdiction: Jurisdiction;
  readonly valued: readonly ValuedAsset[];
  /** Realized volatility override by symbol, 0..1, from the market-data feed. */
  readonly volatilityBySymbol?: ReadonlyMap<string, Decimal>;
  /** Liquidity override by symbol, 0..1, from order-book depth. */
  readonly liquidityBySymbol?: ReadonlyMap<string, Decimal>;
  readonly policy: RiskPolicy;
  readonly now: Date;
}

/** Depeg beyond this multiple of the policy threshold removes eligibility outright. */
const SEVERE_DEPEG_MULTIPLE = 10;

interface Preliminary {
  readonly valued: ValuedAsset;
  readonly eligibilityFactor: Decimal;
  readonly haircut: Decimal;
  readonly liquidityAdjustment: Decimal;
  /** Value before the concentration pass. */
  readonly preConcentration: Money;
  readonly reasons: IneligibilityReason[];
  readonly concentrationCap: Decimal;
  readonly issuer: string | null;
  readonly degraded: boolean;
}

/**
 * Haircut responsive to market conditions.
 *
 * The base haircut already prices in the asset's *expected* volatility, so
 * only volatility in excess of that expectation adds to it. Without this the
 * base and the dynamic term would double-count and BTC would sit permanently
 * at its ceiling haircut.
 */
export const computeHaircut = (
  base: Decimal, expectedVol: Decimal, observedVol: Decimal, multiplier: Decimal, max: Decimal,
): Decimal => {
  const excess = observedVol.minus(expectedVol);
  const dynamic = excess.gt(0) ? excess.times(multiplier) : ZERO;
  return clamp(base.plus(dynamic), base, max);
};

const collectReasons = (p: Preliminary): IneligibilityReason[] => p.reasons;

export const computeCollateral = (input: CollateralInputs): CollateralSummary => {
  const { policy, now, jurisdiction } = input;
  const currency = policy.facilityCurrency;
  const jp = policy.jurisdictions[jurisdiction];

  const prelim: Preliminary[] = input.valued.map((v) => {
    const h = v.holding;
    const symbol = h.symbol.toUpperCase();
    const ap = resolveAssetPolicy(policy, h.assetClass, symbol);
    const reasons: IneligibilityReason[] = [];
    let degraded = false;

    // --- Hard eligibility gates ------------------------------------------
    if (!h.pledged) reasons.push('not_pledged');
    if (h.excluded) reasons.push('excluded_by_customer');
    if (!ap.eligibleForCollateral) reasons.push('asset_class_not_eligible');
    if (!jp?.enabled || !jp.permittedAssetClasses.includes(h.assetClass)) {
      reasons.push('jurisdiction_restricted');
    }
    if (h.assetClass === 'STABLECOIN') {
      if (!policy.stablecoins.whitelist.includes(symbol)) reasons.push('symbol_not_whitelisted');
      else if (jp && !jp.permittedStablecoins.includes(symbol)) reasons.push('jurisdiction_restricted');
    }
    // Self-custody is verifiable on-chain but we cannot seize it, so it is
    // only admitted where the holding is backed by a control attestation.
    if (h.custodyModel === 'self_custody_verified' && h.verification !== 'onchain_signature') {
      reasons.push('custody_model_not_eligible');
    }
    if (h.verification === 'manual_review') reasons.push('custody_model_not_eligible');

    // --- Data-quality gates ----------------------------------------------
    if (isPriceStaleFor(v, policy, now)) { reasons.push('stale_price'); degraded = true; }
    if (v.price.disputed) { reasons.push('disputed_price'); degraded = true; }

    const verificationAgeHours = (now.getTime() - h.lastVerifiedAt.getTime()) / 3_600_000;
    if (verificationAgeHours > ap.maxVerificationAgeHours) {
      reasons.push('verification_expired'); degraded = true;
    }

    // --- Depeg handling ---------------------------------------------------
    let depegExtraHaircut = ZERO;
    if (h.assetClass === 'STABLECOIN' && isDepegged(v.price, policy)) {
      const deviation = v.price.price.minus(ONE).abs();
      const severe = deviation.gt(D(policy.stablecoins.depegThreshold).times(SEVERE_DEPEG_MULTIPLE));
      if (severe) reasons.push('depeg_detected');
      else depegExtraHaircut = D(policy.stablecoins.depegHaircut);
      degraded = true;
    }

    if (v.marketValue.amount.lt(D(ap.dustThreshold))) reasons.push('below_dust_threshold');

    // --- Value terms ------------------------------------------------------
    const eligibilityFactor = D(ap.eligibilityFactor);
    const observedVol = input.volatilityBySymbol?.get(symbol) ?? D(ap.defaultVolatility);
    const haircut = clamp(
      computeHaircut(
        D(ap.baseHaircut), D(ap.defaultVolatility), observedVol,
        D(ap.volatilityHaircutMultiplier), D(ap.maxHaircut),
      ).plus(depegExtraHaircut),
      0, 1,
    );
    const liquidityAdjustment = clamp(
      input.liquidityBySymbol?.get(symbol) ?? D(ap.defaultLiquidity), 0, 1,
    );

    const preConcentration = reasons.length > 0
      ? Money.zero(currency)
      : v.marketValue.times(eligibilityFactor).times(ONE.minus(haircut)).times(liquidityAdjustment);

    return {
      valued: v, eligibilityFactor, haircut, liquidityAdjustment,
      preConcentration, reasons,
      concentrationCap: D(ap.concentrationCap),
      issuer: h.assetClass === 'STABLECOIN' ? (policy.stablecoins.issuerBySymbol[symbol] ?? null) : null,
      degraded,
    };
  });

  // --- Concentration pass ---------------------------------------------------
  // Shares are measured against the pre-concentration total, not against the
  // post-adjustment total. A self-referential cap would drive a single-asset
  // portfolio to zero through repeated application; measuring against the
  // unadjusted base makes an over-cap position contribute exactly
  // `cap x total`, which is the intent.
  const preTotal = prelim.reduce((a, p) => a.plus(p.preConcentration), Money.zero(currency));

  const issuerTotals = new Map<string, Decimal>();
  for (const p of prelim) {
    if (!p.issuer) continue;
    issuerTotals.set(p.issuer, (issuerTotals.get(p.issuer) ?? ZERO).plus(p.preConcentration.amount));
  }

  const positions: CollateralPosition[] = prelim.map((p) => {
    let concentrationAdjustment = ONE;

    if (preTotal.isPositive() && p.preConcentration.isPositive()) {
      const share = p.preConcentration.amount.dividedBy(preTotal.amount);
      if (share.gt(p.concentrationCap)) {
        concentrationAdjustment = p.concentrationCap.dividedBy(share);
      }
      // Issuer cap binds across every symbol from the same stablecoin issuer.
      if (p.issuer) {
        const issuerTotal = issuerTotals.get(p.issuer) ?? ZERO;
        const issuerShare = issuerTotal.dividedBy(preTotal.amount);
        const issuerCap = D(policy.stablecoins.issuerConcentrationCap);
        if (issuerShare.gt(issuerCap)) {
          const issuerAdj = issuerCap.dividedBy(issuerShare);
          if (issuerAdj.lt(concentrationAdjustment)) concentrationAdjustment = issuerAdj;
        }
      }
    }

    const eligibleValue = p.preConcentration.times(concentrationAdjustment);
    const h = p.valued.holding;

    return {
      assetId: h.assetId,
      symbol: h.symbol.toUpperCase(),
      assetClass: h.assetClass,
      quantity: h.quantity,
      marketValue: p.valued.marketValue,
      eligibilityFactor: p.eligibilityFactor,
      haircut: p.haircut,
      liquidityAdjustment: p.liquidityAdjustment,
      concentrationAdjustment,
      eligibleValue,
      concentration: ZERO, // filled in below, once the final total is known
      eligible: p.reasons.length === 0 && eligibleValue.isPositive(),
      ineligibilityReasons: collectReasons(p),
      priceAsOf: p.valued.price.asOf,
    };
  });

  const eligibleCollateralValue = positions.reduce((a, p) => a.plus(p.eligibleValue), Money.zero(currency));
  const totalMarketValue = input.valued.reduce((a, v) => a.plus(v.marketValue), Money.zero(currency));

  const withShares: CollateralPosition[] = positions.map((p) => ({
    ...p,
    concentration: eligibleCollateralValue.isPositive()
      ? p.eligibleValue.amount.dividedBy(eligibleCollateralValue.amount)
      : ZERO,
  }));

  const concentrationCapBinding = withShares.some((p) => p.concentrationAdjustment.lt(ONE));

  const topConcentration = withShares.reduce(
    (max, p) => (p.concentration.gt(max) ? p.concentration : max), ZERO,
  );

  // Eligible-value-weighted risk descriptors, used by the credit engine.
  let volAcc = ZERO, liqAcc = ZERO;
  for (const p of withShares) {
    if (!p.eligible) continue;
    const ap = resolveAssetPolicy(policy, p.assetClass, p.symbol);
    const vol = input.volatilityBySymbol?.get(p.symbol) ?? D(ap.defaultVolatility);
    volAcc = volAcc.plus(vol.times(p.concentration));
    liqAcc = liqAcc.plus(p.liquidityAdjustment.times(p.concentration));
  }

  return {
    customerId: input.customerId,
    currency,
    totalMarketValue,
    eligibleCollateralValue,
    positions: withShares,
    topConcentration,
    weightedVolatility: clamp(volAcc, 0, 1),
    weightedLiquidity: eligibleCollateralValue.isPositive() ? clamp(liqAcc, 0, 1) : ZERO,
    concentrationCapBinding,
    policyVersion: policy.version,
    computedAt: now,
    degraded: prelim.some((p) => p.degraded),
  };
};

/** Plain-language rendering of why a position was refused, for UI and AI. */
export const describeIneligibility = (reason: IneligibilityReason): string => {
  switch (reason) {
    case 'not_pledged': return 'Not pledged as collateral';
    case 'excluded_by_customer': return 'Excluded from collateral at your request';
    case 'asset_class_not_eligible': return 'This asset class is not eligible collateral in the current programme';
    case 'symbol_not_whitelisted': return 'This token is not on the approved collateral list';
    case 'jurisdiction_restricted': return 'Not permitted as collateral in your jurisdiction';
    case 'stale_price': return 'No recent verified price — collateral value is suspended until pricing recovers';
    case 'disputed_price': return 'Price sources disagree — collateral value is suspended pending review';
    case 'verification_expired': return 'Ownership verification has expired — reconnect the account';
    case 'custody_model_not_eligible': return 'This custody arrangement is not eligible for collateral';
    case 'depeg_detected': return 'The stablecoin is trading materially away from its peg';
    case 'below_dust_threshold': return 'Position is below the minimum collateral size';
  }
};

/** Positions ordered for a forced sale: cheapest and most liquid first. */
export const liquidationOrder = (
  positions: readonly CollateralPosition[], policy: RiskPolicy,
): CollateralPosition[] =>
  positions
    .filter((p) => p.eligible && p.eligibleValue.isPositive())
    .sort((a, b) => {
      const pa = resolveAssetPolicy(policy, a.assetClass, a.symbol);
      const pb = resolveAssetPolicy(policy, b.assetClass, b.symbol);
      if (pa.liquidationPriority !== pb.liquidationPriority) {
        return pa.liquidationPriority - pb.liquidationPriority;
      }
      // Within a priority band, sell the deeper book first.
      const liq = b.liquidityAdjustment.comparedTo(a.liquidityAdjustment);
      if (liq !== 0) return liq;
      return b.eligibleValue.amount.comparedTo(a.eligibleValue.amount);
    });

/** Aggregate eligible value by asset class — used by stress tests and the UI. */
export const byAssetClass = (
  summary: CollateralSummary,
): Map<AssetClass, { marketValue: Money; eligibleValue: Money }> => {
  const out = new Map<AssetClass, { marketValue: Money; eligibleValue: Money }>();
  for (const p of summary.positions) {
    const cur = out.get(p.assetClass) ?? {
      marketValue: Money.zero(summary.currency),
      eligibleValue: Money.zero(summary.currency),
    };
    out.set(p.assetClass, {
      marketValue: cur.marketValue.plus(p.marketValue),
      eligibleValue: cur.eligibleValue.plus(p.eligibleValue),
    });
  }
  return out;
};

/**
 * Re-price one eligible position under a stress scenario.
 *
 * Lives here rather than in the risk engine because it is a collateral
 * operation, and because both the risk engine and the credit engine need it:
 * putting it in either of those would create an import cycle.
 */
export const shockedEligibleValue = (
  p: CollateralPosition, scenario: StressScenario, policy: RiskPolicy,
): Money => {
  if (!p.eligible) return Money.zero(p.eligibleValue.currency);

  let shockedMarket = p.marketValue;

  const classShock = scenario.shocks[p.assetClass];
  if (classShock) shockedMarket = shockedMarket.times(ONE.plus(D(classShock)));

  // A depeg is a price level, not a percentage move, so it replaces the mark
  // rather than multiplying it.
  if (scenario.stablecoinPeg && p.assetClass === 'STABLECOIN') {
    shockedMarket = p.marketValue.times(D(scenario.stablecoinPeg));
  }
  if (shockedMarket.isNegative()) shockedMarket = Money.zero(shockedMarket.currency);

  const stressedHaircut = clamp(
    p.haircut.plus(scenario.liquidityShock ? D(scenario.liquidityShock) : ZERO), 0, 1,
  );

  return shockedMarket
    .times(p.eligibilityFactor)
    .times(ONE.minus(stressedHaircut))
    .times(p.liquidityAdjustment)
    .times(p.concentrationAdjustment);
};

/** Eligible collateral surviving a scenario, across the whole book. */
export const shockedCollateralValue = (
  summary: CollateralSummary, scenario: StressScenario, policy: RiskPolicy,
): Money =>
  summary.positions.reduce(
    (acc, p) => acc.plus(shockedEligibleValue(p, scenario, policy)),
    Money.zero(summary.currency),
  );
