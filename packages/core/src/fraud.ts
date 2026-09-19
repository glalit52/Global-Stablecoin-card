/**
 * Fraud engine (PRD §17.2).
 *
 * A transparent, additive rule set rather than an opaque score. Every signal
 * that fires records its own weight and a sentence explaining itself, because
 * a declined customer is owed a reason and a disputed chargeback needs
 * evidence of what the system saw at the time.
 *
 * Deliberately deterministic: no model inference on the authorization path.
 * PRD §19.2 requires production risk rules and experimental models to stay
 * separate, and an authorization has an 800ms budget it cannot spend waiting.
 */
import { clamp, D, Decimal, Money, ONE, ZERO } from './money.js';
import type { RiskPolicy } from './policy.js';
import type { AuthorizationRequest, MerchantCategory } from './types.js';

export interface FraudSignal {
  readonly code: string;
  readonly weight: Decimal;
  readonly detail: string;
}

export interface FraudAssessment {
  readonly score: Decimal;
  readonly signals: readonly FraudSignal[];
  readonly decline: boolean;
  readonly requireStepUp: boolean;
}

export interface RecentTransaction {
  readonly amount: Money;
  readonly at: Date;
  readonly merchantCountry: string;
  readonly geo?: { lat: number; lon: number };
  readonly declined: boolean;
}

export interface FraudContext {
  readonly recent: readonly RecentTransaction[];
  /** Trailing mean ticket for this customer. Null for a new account. */
  readonly averageTicket: Money | null;
  /** Countries the customer has transacted in before. */
  readonly knownCountries: ReadonlySet<string>;
  /** Devices previously bound to the account. */
  readonly knownDevices: ReadonlySet<string>;
  readonly accountAgeDays: number;
  /** Set when the customer has told us they are travelling. */
  readonly travelNoticeCountries: ReadonlySet<string>;
  readonly policy: RiskPolicy;
  readonly now: Date;
}

/** Great-circle distance in kilometres. */
export const haversineKm = (
  a: { lat: number; lon: number }, b: { lat: number; lon: number },
): number => {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};

export const assessFraud = (
  req: AuthorizationRequest, ctx: FraudContext,
): FraudAssessment => {
  const { policy } = ctx;
  const fp = policy.fraud;
  const signals: FraudSignal[] = [];

  const add = (code: string, weight: string, detail: string) =>
    signals.push({ code, weight: D(weight), detail });

  // --- Velocity ------------------------------------------------------------
  const windowStart = ctx.now.getTime() - fp.velocityWindowMinutes * 60_000;
  const inWindow = ctx.recent.filter((t) => t.at.getTime() >= windowStart);
  if (inWindow.length >= fp.velocityCount) {
    add('velocity', '0.30',
      `${inWindow.length} transactions in the last ${fp.velocityWindowMinutes} minutes`);
  }

  // Repeated declines are the classic card-testing pattern.
  const recentDeclines = inWindow.filter((t) => t.declined).length;
  if (recentDeclines >= 3) {
    add('decline_probing', '0.35', `${recentDeclines} declines in the last ${fp.velocityWindowMinutes} minutes`);
  }

  // --- Amount anomaly ------------------------------------------------------
  if (ctx.averageTicket?.isPositive()) {
    const multiple = req.amount.amount.dividedBy(ctx.averageTicket.amount);
    if (multiple.gte(D(fp.amountAnomalyMultiple))) {
      add('amount_anomaly', '0.25',
        `${multiple.toDecimalPlaces(1)}x your typical transaction size`);
    }
  } else if (ctx.accountAgeDays < 7 && req.amount.amount.gt(2_000)) {
    add('new_account_large_ticket', '0.20',
      'Large transaction on an account less than a week old');
  }

  // --- Geography -----------------------------------------------------------
  const country = req.merchantCountry.toUpperCase();
  const isCardPresent = req.entryMode === 'contactless' || req.entryMode === 'chip' || req.entryMode === 'atm';

  if (!ctx.knownCountries.has(country) && !ctx.travelNoticeCountries.has(country)) {
    add('new_country', isCardPresent ? '0.20' : '0.12',
      `First transaction in ${country}`);
  }

  // Impossible travel only means anything for card-present transactions —
  // an e-commerce purchase can legitimately be billed anywhere on earth.
  if (isCardPresent && req.geo) {
    const priorWithGeo = ctx.recent
      .filter((t) => t.geo && !t.declined)
      .sort((a, b) => b.at.getTime() - a.at.getTime())[0];
    if (priorWithGeo?.geo) {
      const km = haversineKm(priorWithGeo.geo, req.geo);
      const hours = (req.requestedAt.getTime() - priorWithGeo.at.getTime()) / 3_600_000;
      if (hours > 0 && km > 100) {
        const kmh = km / hours;
        if (kmh > fp.impossibleTravelKmh) {
          add('impossible_travel', '0.45',
            `${Math.round(km)} km from the previous card-present transaction ${hours.toFixed(1)} hours earlier`);
        }
      }
    }
  }

  // --- Device --------------------------------------------------------------
  if (req.deviceId && !ctx.knownDevices.has(req.deviceId)) {
    add('unknown_device', '0.15', 'Transaction initiated from an unrecognised device');
  }
  if (!req.deviceId && req.entryMode === 'ecommerce') {
    add('no_device_signal', '0.10', 'Online transaction with no device attestation');
  }

  // --- Merchant risk -------------------------------------------------------
  if (fp.highRiskMccs.includes(req.mcc)) {
    add('high_risk_mcc', '0.20', `Merchant category ${req.mcc} carries elevated risk`);
  }
  if (req.entryMode === 'manual') {
    add('manual_entry', '0.18', 'Card number entered by hand');
  }

  const score = clamp(signals.reduce((a, s) => a.plus(s.weight), ZERO), 0, 1);

  // A recurring charge to a merchant the customer already pays should not be
  // knocked out by geography signals it cannot control.
  const declineThreshold = req.isRecurring ? ONE : D(fp.declineThreshold);

  return {
    score,
    signals,
    decline: score.gte(declineThreshold),
    requireStepUp:
      score.gte(D(fp.stepUpThreshold)) ||
      (fp.highRiskMccs.includes(req.mcc) && !req.isRecurring),
  };
};

/** MCC to the customer-facing category used for rewards and spend analytics. */
export const categoryForMcc = (mcc: string): MerchantCategory => {
  const code = Number.parseInt(mcc, 10);
  if (Number.isNaN(code)) return 'other';
  if (code === 5411 || code === 5422 || code === 5441 || code === 5451 || code === 5462 || code === 5499) return 'groceries';
  if (code === 5541 || code === 5542 || code === 5552 || code === 5983) return 'fuel_ev';
  if (code >= 5811 && code <= 5814) return 'dining';
  if (code >= 3500 && code <= 3999) return 'hotels';
  if (code === 7011) return 'hotels';
  if (code === 7032 || code === 7033) return 'travel';
  if (code >= 3000 && code <= 3299) return 'travel';
  if (code === 4511 || code === 4722 || code === 4582) return 'travel';
  if (code === 4112 || code === 4111 || code === 4131 || code === 4121 || code === 4789) return 'transit';
  if (code === 5399 || code === 5311 || code === 5651 || code === 5691 || code === 5732 || code === 5944) return 'retail';
  if (code === 5815 || code === 5816 || code === 5817 || code === 5818) return 'subscriptions';
  if (code === 4814 || code === 4899 || code === 4900) return 'utilities';
  if (code === 6011 || code === 6010) return 'cash_advance';
  if (code === 6051 || code === 6540) return 'crypto';
  if (code === 7995) return 'gambling';
  if (code === 5964 || code === 5969 || code === 5999) return 'ecommerce';
  if (code === 5993 || code === 7519) return 'other';
  return 'other';
};

/** Airport-lounge MCCs get their own category so the tier benefit can be applied. */
export const LOUNGE_MCCS = new Set(['4511', '7011']);
