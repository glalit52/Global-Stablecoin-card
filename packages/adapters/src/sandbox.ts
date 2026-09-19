/**
 * Sandbox partner implementations.
 *
 * These stand in for the licensed partners of PRD §18.2 so the whole platform
 * runs end to end without contracts in place. They implement the same ports a
 * production adapter would, which is the point: replacing one is a new file,
 * not a refactor.
 *
 * They are deliberately honest about being simulations — every result carries
 * a `sandbox-` prefixed reference, and card numbers come from the universally
 * recognised 4242 test range so nothing here can be mistaken for a real
 * instrument.
 */
import { D, Decimal, Money } from '@wealthcard/core';
import type {
  AssetClass, CardControls, CardStatus, KycStatus, PriceQuote,
} from '@wealthcard/core';
import { MarketSimulator, sharedMarket } from './market.js';
import {
  PartnerError,
  type CardIssuer, type CardSecrets, type CustodyBalance, type CustodyProvider,
  type FundingDraw, type IssueCardRequest, type IssuedCard, type KycApplicant,
  type KycProvider, type KycResult, type LendingPartner, type LiquidationFill,
  type MarketDataProvider, type NotificationRequest, type Notifier, type PartnerRegistry,
  type PledgeResult, type StablecoinRail, type StablecoinTransfer,
} from './ports.js';

const rid = (prefix: string): string =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

/**
 * Idempotency cache shared by every sandbox adapter.
 * A production adapter would rely on the partner's own idempotency semantics;
 * here we enforce them so the rest of the platform is exercised against the
 * same guarantees.
 */
class IdempotencyStore {
  private readonly entries = new Map<string, unknown>();
  run<T>(key: string, fn: () => T): T {
    if (this.entries.has(key)) return this.entries.get(key) as T;
    const result = fn();
    this.entries.set(key, result);
    return result;
  }
  has(key: string): boolean { return this.entries.has(key); }
}

// ---------------------------------------------------------------------------
// KYC
// ---------------------------------------------------------------------------

/**
 * Deterministic KYC decisions driven by the applicant's name, so demos and
 * tests can exercise every branch:
 *   - a name containing "sanction" fails screening,
 *   - "pep" flags a politically exposed person,
 *   - "review" lands in manual review,
 *   - anything else is approved.
 */
export class SandboxKycProvider implements KycProvider {
  readonly name = 'sandbox-kyc';
  private readonly results = new Map<string, KycResult>();
  private readonly idem = new IdempotencyStore();

  async submit(applicant: KycApplicant, idempotencyKey: string): Promise<KycResult> {
    return this.idem.run(idempotencyKey, () => {
      const n = applicant.legalName.toLowerCase();
      const reference = rid('sandbox-kyc');

      let status: KycStatus = 'approved';
      const reasons: string[] = [];
      let sanctionsClear = true, pepMatch = false, adverseMedia = false;
      let riskScore = D('0.05');

      if (n.includes('sanction')) {
        status = 'rejected'; sanctionsClear = false; riskScore = D('0.98');
        reasons.push('sanctions_list_match');
      } else if (n.includes('pep')) {
        status = 'in_review'; pepMatch = true; riskScore = D('0.55');
        reasons.push('politically_exposed_person');
      } else if (n.includes('adverse')) {
        status = 'in_review'; adverseMedia = true; riskScore = D('0.45');
        reasons.push('adverse_media_hit');
      } else if (n.includes('review')) {
        status = 'in_review'; riskScore = D('0.30');
        reasons.push('manual_review_required');
      }

      // A document is required everywhere the programme is live.
      if (status === 'approved' && !applicant.documentNumber) {
        status = 'pending';
        reasons.push('identity_document_required');
      }

      const result: KycResult = {
        status, reference, sanctionsClear, pepMatch, adverseMedia,
        riskScore, reasons, checkedAt: new Date(),
      };
      this.results.set(reference, result);
      return result;
    });
  }

  async get(reference: string): Promise<KycResult | null> {
    return this.results.get(reference) ?? null;
  }

  async rescreen(reference: string): Promise<KycResult> {
    const existing = this.results.get(reference);
    if (!existing) throw new PartnerError(this.name, 'not_found', `unknown reference ${reference}`, false);
    const refreshed = { ...existing, checkedAt: new Date() };
    this.results.set(reference, refreshed);
    return refreshed;
  }

  /** Test hook: force a reference into a given state. */
  override_(reference: string, patch: Partial<KycResult>): void {
    const existing = this.results.get(reference);
    if (existing) this.results.set(reference, { ...existing, ...patch });
  }
}

// ---------------------------------------------------------------------------
// Card issuing
// ---------------------------------------------------------------------------

/** Complete a 15-digit base into a Luhn-valid 16-digit number. */
const luhnComplete = (base15: string): string => {
  let sum = 0;
  for (let i = 0; i < base15.length; i++) {
    let d = Number(base15[base15.length - 1 - i]);
    if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return base15 + String((10 - (sum % 10)) % 10);
};

interface SandboxCardRecord {
  readonly partnerCardId: string;
  readonly customerId: string;
  readonly pan: string;
  readonly cvv: string;
  readonly expMonth: number;
  readonly expYear: number;
  status: CardStatus;
  controls: CardControls | null;
  wallets: string[];
}

export class SandboxCardIssuer implements CardIssuer {
  readonly name = 'sandbox-issuer';
  private readonly cards = new Map<string, SandboxCardRecord>();
  private readonly idem = new IdempotencyStore();
  private counter = 0;

  async issue(req: IssueCardRequest, idempotencyKey: string): Promise<IssuedCard> {
    return this.idem.run(idempotencyKey, () => {
      this.counter += 1;
      // The 4242 42.. range is the universally recognised test BIN. Nothing
      // here could be mistaken for, or used as, a real instrument.
      const base = `424242${String(this.counter).padStart(9, '0')}`;
      const pan = luhnComplete(base);
      const now = new Date();
      const record: SandboxCardRecord = {
        partnerCardId: rid('sandbox-card'),
        customerId: req.customerId,
        pan,
        cvv: String(100 + (this.counter % 900)),
        expMonth: now.getUTCMonth() + 1,
        expYear: now.getUTCFullYear() + 4,
        // Virtual cards are usable immediately; a physical card must be
        // activated on arrival, which is the real-world behaviour.
        status: req.form === 'virtual' ? 'active' : 'inactive',
        controls: null,
        wallets: [],
      };
      this.cards.set(record.partnerCardId, record);
      return {
        partnerCardId: record.partnerCardId,
        tokenReference: `tok_${record.partnerCardId}`,
        last4: pan.slice(-4),
        expMonth: record.expMonth,
        expYear: record.expYear,
        status: record.status,
      };
    });
  }

  async setStatus(partnerCardId: string, status: CardStatus, idempotencyKey: string): Promise<void> {
    this.idem.run(idempotencyKey, () => {
      const card = this.require(partnerCardId);
      // A card reported lost or stolen is terminal: it must never be revived
      // by a later freeze/unfreeze call.
      if (card.status === 'lost_stolen' && status !== 'cancelled') {
        throw new PartnerError(this.name, 'card_terminal', 'card reported lost or stolen cannot be reactivated', false);
      }
      card.status = status;
      return null;
    });
  }

  async updateControls(partnerCardId: string, controls: CardControls, idempotencyKey: string): Promise<void> {
    this.idem.run(idempotencyKey, () => {
      this.require(partnerCardId).controls = controls;
      return null;
    });
  }

  async reveal(partnerCardId: string, customerId: string): Promise<CardSecrets> {
    const card = this.require(partnerCardId);
    if (card.customerId !== customerId) {
      throw new PartnerError(this.name, 'forbidden', 'card does not belong to this customer', false);
    }
    return { pan: card.pan, cvv: card.cvv, expMonth: card.expMonth, expYear: card.expYear };
  }

  async provisionWallet(
    partnerCardId: string, wallet: 'apple_pay' | 'google_pay', idempotencyKey: string,
  ): Promise<{ activationData: string }> {
    return this.idem.run(idempotencyKey, () => {
      const card = this.require(partnerCardId);
      if (card.status !== 'active') {
        throw new PartnerError(this.name, 'card_not_active', 'card must be active before wallet provisioning', false);
      }
      if (!card.wallets.includes(wallet)) card.wallets.push(wallet);
      return { activationData: Buffer.from(`${partnerCardId}:${wallet}`).toString('base64') };
    });
  }

  private require(partnerCardId: string): SandboxCardRecord {
    const card = this.cards.get(partnerCardId);
    if (!card) throw new PartnerError(this.name, 'not_found', `unknown card ${partnerCardId}`, false);
    return card;
  }
}

// ---------------------------------------------------------------------------
// Custody
// ---------------------------------------------------------------------------

interface CustodyAccount {
  readonly accountId: string;
  balances: Map<string, { assetClass: AssetClass; quantity: Decimal; pledged: Decimal }>;
  pledges: Map<string, { symbol: string; quantity: Decimal }>;
}

/**
 * Loads an account's holdings when the provider has never seen it.
 *
 * A real custodian keeps its own durable books, so its state outlives any one
 * of our processes. This in-memory stand-in would not: an API server started
 * after the seed script has an empty map and every custody call fails. The
 * hook lets the host rehydrate an account on first touch, which restores the
 * property that matters — custody state is durable and process-independent.
 */
export type CustodyHydrator = (
  custodyAccountId: string,
) => Promise<readonly { symbol: string; assetClass: AssetClass; quantity: string; pledged?: boolean }[]>;

export class SandboxCustodyProvider implements CustodyProvider {
  readonly name = 'sandbox-custody';
  private readonly accounts = new Map<string, CustodyAccount>();
  private readonly idem = new IdempotencyStore();
  private readonly hydrate: CustodyHydrator | null;

  constructor(
    private readonly market: MarketSimulator = sharedMarket(),
    hydrate: CustodyHydrator | null = null,
  ) {
    this.hydrate = hydrate;
  }

  /** Pull an unknown account into memory before touching it. */
  private async ensure(custodyAccountId: string): Promise<void> {
    if (this.accounts.has(custodyAccountId) || !this.hydrate) return;
    const holdings = await this.hydrate(custodyAccountId);
    if (holdings.length === 0) return;
    this.accounts.set(custodyAccountId, {
      accountId: custodyAccountId,
      balances: new Map(holdings.map((h) => [
        h.symbol.toUpperCase(),
        {
          assetClass: h.assetClass,
          quantity: D(h.quantity),
          pledged: h.pledged ? D(h.quantity) : D(0),
        },
      ])),
      pledges: new Map(),
    });
  }

  /** Seed an account. Used by the seeder and by tests. */
  seedAccount(
    accountId: string,
    holdings: readonly { symbol: string; assetClass: AssetClass; quantity: string }[],
  ): void {
    this.accounts.set(accountId, {
      accountId,
      balances: new Map(holdings.map((h) => [
        h.symbol.toUpperCase(),
        { assetClass: h.assetClass, quantity: D(h.quantity), pledged: D(0) },
      ])),
      pledges: new Map(),
    });
  }

  async listBalances(custodyAccountId: string): Promise<CustodyBalance[]> {
    await this.ensure(custodyAccountId);
    const account = this.accounts.get(custodyAccountId);
    if (!account) return [];
    const asOf = new Date();
    return [...account.balances].map(([symbol, b]) => ({
      symbol,
      assetClass: b.assetClass,
      quantity: b.quantity,
      availableQuantity: b.quantity.minus(b.pledged),
      pledgedQuantity: b.pledged,
      asOf,
    }));
  }

  async pledge(
    custodyAccountId: string, symbol: string, quantity: Decimal, idempotencyKey: string,
  ): Promise<PledgeResult> {
    await this.ensure(custodyAccountId);
    return this.idem.run(idempotencyKey, () => {
      const account = this.require(custodyAccountId);
      const balance = account.balances.get(symbol.toUpperCase());
      if (!balance) throw new PartnerError(this.name, 'no_balance', `no ${symbol} at custodian`, false);
      const available = balance.quantity.minus(balance.pledged);
      if (quantity.gt(available)) {
        throw new PartnerError(this.name, 'insufficient_balance',
          `cannot pledge ${quantity} ${symbol}: only ${available} unpledged`, false);
      }
      balance.pledged = balance.pledged.plus(quantity);
      const pledgeId = rid('sandbox-pledge');
      account.pledges.set(pledgeId, { symbol: symbol.toUpperCase(), quantity });
      return { pledgeId, symbol: symbol.toUpperCase(), quantity, confirmedAt: new Date() };
    });
  }

  async release(
    custodyAccountId: string, pledgeId: string, quantity: Decimal, idempotencyKey: string,
  ): Promise<void> {
    await this.ensure(custodyAccountId);
    this.idem.run(idempotencyKey, () => {
      const account = this.require(custodyAccountId);
      const pledge = account.pledges.get(pledgeId);
      if (!pledge) throw new PartnerError(this.name, 'not_found', `unknown pledge ${pledgeId}`, false);
      if (quantity.gt(pledge.quantity)) {
        throw new PartnerError(this.name, 'over_release', 'release exceeds pledged quantity', false);
      }
      const balance = account.balances.get(pledge.symbol)!;
      balance.pledged = balance.pledged.minus(quantity);
      const remaining = pledge.quantity.minus(quantity);
      if (remaining.lte(0)) account.pledges.delete(pledgeId);
      else account.pledges.set(pledgeId, { ...pledge, quantity: remaining });
      return null;
    });
  }

  async liquidate(
    custodyAccountId: string, symbol: string, quantity: Decimal, idempotencyKey: string,
  ): Promise<LiquidationFill> {
    await this.ensure(custodyAccountId);
    // Idempotency matters most here: a replayed sell is unrecoverable.
    return this.idem.run(idempotencyKey, () => {
      const account = this.require(custodyAccountId);
      const key = symbol.toUpperCase();
      const balance = account.balances.get(key);
      if (!balance) throw new PartnerError(this.name, 'no_balance', `no ${symbol} at custodian`, false);
      if (quantity.gt(balance.quantity)) {
        throw new PartnerError(this.name, 'insufficient_balance', 'cannot sell more than is held', false);
      }

      const spot = this.market.priceOf(key);
      if (!spot) throw new PartnerError(this.name, 'no_price', `no market price for ${symbol}`, true);

      // Execution lands a little below spot: market impact on a forced sale.
      const executedPrice = spot.times(D('0.997'));
      const gross = Money.of(quantity.times(executedPrice), 'USD');
      const fees = gross.times(D('0.002')).roundUp();

      balance.quantity = balance.quantity.minus(quantity);
      balance.pledged = balance.pledged.gt(balance.quantity) ? balance.quantity : balance.pledged;

      return {
        fillId: rid('sandbox-fill'),
        symbol: key,
        quantity,
        executedPrice,
        grossProceeds: gross.roundDown(),
        fees,
        netProceeds: gross.minus(fees).roundDown(),
        venue: 'sandbox-otc',
        executedAt: new Date(),
      };
    });
  }

  async verifyAddressOwnership(address: string, signature: string, challenge: string): Promise<boolean> {
    // A production adapter verifies a real secp256k1/Ed25519 signature. The
    // sandbox accepts a signature that demonstrably derives from both the
    // address and the challenge, so the flow cannot be satisfied by a constant.
    const expected = Buffer.from(`${address}:${challenge}`).toString('base64');
    return signature === expected;
  }

  /** Test/demo hook mirroring a deposit landing at the custodian. */
  credit(custodyAccountId: string, symbol: string, assetClass: AssetClass, quantity: string): void {
    const account = this.accounts.get(custodyAccountId) ?? {
      accountId: custodyAccountId, balances: new Map(), pledges: new Map(),
    };
    const key = symbol.toUpperCase();
    const existing = account.balances.get(key);
    account.balances.set(key, existing
      ? { ...existing, quantity: existing.quantity.plus(D(quantity)) }
      : { assetClass, quantity: D(quantity), pledged: D(0) });
    this.accounts.set(custodyAccountId, account);
  }

  private require(accountId: string): CustodyAccount {
    const account = this.accounts.get(accountId);
    if (!account) throw new PartnerError(this.name, 'not_found', `unknown custody account ${accountId}`, false);
    return account;
  }
}

// ---------------------------------------------------------------------------
// Market data
// ---------------------------------------------------------------------------

/**
 * One instance per upstream feed. Each applies its own jitter around the true
 * price so the consolidator in the core sees genuine dispersion and its
 * median/disputed logic is actually exercised.
 */
export class SandboxMarketDataProvider implements MarketDataProvider {
  constructor(
    readonly name: string,
    private readonly jitterBps: number,
    private readonly market: MarketSimulator = sharedMarket(),
    /** Simulated feed latency, in seconds, applied to every quote's asOf. */
    private readonly lagSeconds = 0,
  ) {}

  async quotes(symbols: readonly string[]): Promise<PriceQuote[]> {
    const asOf = new Date(Date.now() - this.lagSeconds * 1000);
    const out: PriceQuote[] = [];
    for (const symbol of symbols) {
      const spot = this.market.priceOf(symbol);
      if (!spot) continue;
      out.push({
        symbol: symbol.toUpperCase(),
        currency: 'USD',
        price: spot.times(this.market.jitter(this.jitterBps)),
        asOf,
        source: this.name,
      });
    }
    return out;
  }

  async history(symbol: string, days: number): Promise<Decimal[]> {
    return this.market.historyOf(symbol, days);
  }

  async fxRates(base: string, quotes: readonly string[]): Promise<Map<string, Decimal>> {
    if (base.toUpperCase() !== 'USD') {
      throw new PartnerError(this.name, 'unsupported_base', 'sandbox feed quotes against USD only', false);
    }
    const out = new Map<string, Decimal>();
    for (const q of quotes) {
      const rate = this.market.fxRate(q);
      if (rate) out.set(q.toUpperCase(), rate);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Stablecoin rail
// ---------------------------------------------------------------------------

/** Addresses containing these markers fail screening, for demo purposes. */
const BLOCKED_ADDRESS_MARKERS = ['mixer', 'sanction', 'darknet'];

export class SandboxStablecoinRail implements StablecoinRail {
  readonly name = 'sandbox-stablecoin';
  private readonly transfers = new Map<string, StablecoinTransfer>();
  private readonly idem = new IdempotencyStore();

  constructor(private readonly market: MarketSimulator = sharedMarket()) {}

  async screenAddress(address: string, _symbol: string) {
    const lower = address.toLowerCase();
    const hit = BLOCKED_ADDRESS_MARKERS.find((m) => lower.includes(m));
    return hit
      ? { clear: false, riskScore: D('0.95'), reasons: [`address_linked_to_${hit}`] }
      : { clear: true, riskScore: D('0.02'), reasons: [] };
  }

  async send(
    symbol: string, amount: Decimal, toAddress: string, idempotencyKey: string,
  ): Promise<StablecoinTransfer> {
    const screen = await this.screenAddress(toAddress, symbol);
    return this.idem.run(idempotencyKey, () => {
      if (!screen.clear) {
        throw new PartnerError(this.name, 'screening_failed',
          `destination failed screening: ${screen.reasons.join(', ')}`, false);
      }
      const transfer: StablecoinTransfer = {
        transferId: rid('sandbox-xfer'),
        symbol: symbol.toUpperCase(),
        amount,
        fromAddress: 'sandbox-treasury',
        toAddress,
        txHash: `0x${Buffer.from(rid('tx')).toString('hex').slice(0, 64)}`,
        networkFee: Money.of('0.35', 'USD'),
        status: 'confirmed',
        confirmations: 12,
        screenedClear: true,
        submittedAt: new Date(),
      };
      this.transfers.set(transfer.transferId, transfer);
      return transfer;
    });
  }

  async get(transferId: string): Promise<StablecoinTransfer | null> {
    return this.transfers.get(transferId) ?? null;
  }

  async pegStatus(symbol: string) {
    const price = this.market.priceOf(symbol) ?? D('1');
    return {
      price,
      depegged: price.minus(1).abs().gt(D('0.01')),
      asOf: new Date(),
    };
  }
}

// ---------------------------------------------------------------------------
// Lending partner
// ---------------------------------------------------------------------------

export class SandboxLendingPartner implements LendingPartner {
  readonly name = 'sandbox-lender';
  private readonly facilities = new Map<string, { customerId: string; limit: Money; drawn: Money }>();
  private readonly idem = new IdempotencyStore();

  /** Programme-level ceiling the lender will not exceed for any one customer. */
  constructor(private readonly partnerCap = Money.of('5000000', 'USD')) {}

  async registerFacility(customerId: string, requestedLimit: Money, idempotencyKey: string) {
    return this.idem.run(idempotencyKey, () => {
      const approvedLimit = requestedLimit.min(this.partnerCap);
      const partnerFacilityId = rid('sandbox-fac');
      this.facilities.set(partnerFacilityId, {
        customerId, limit: approvedLimit, drawn: Money.zero(approvedLimit.currency),
      });
      return { approvedLimit, partnerFacilityId };
    });
  }

  async draw(partnerFacilityId: string, amount: Money, idempotencyKey: string): Promise<FundingDraw> {
    return this.idem.run(idempotencyKey, () => {
      const f = this.facilities.get(partnerFacilityId);
      if (!f) throw new PartnerError(this.name, 'not_found', `unknown facility ${partnerFacilityId}`, false);
      const after = f.drawn.plus(amount);
      if (after.gt(f.limit)) {
        return { drawId: rid('sandbox-draw'), amount, status: 'rejected' as const, fundedAt: null };
      }
      f.drawn = after;
      return { drawId: rid('sandbox-draw'), amount, status: 'funded' as const, fundedAt: new Date() };
    });
  }

  async repay(partnerFacilityId: string, amount: Money, idempotencyKey: string): Promise<void> {
    this.idem.run(idempotencyKey, () => {
      const f = this.facilities.get(partnerFacilityId);
      if (!f) throw new PartnerError(this.name, 'not_found', `unknown facility ${partnerFacilityId}`, false);
      f.drawn = f.drawn.minus(amount).clampPositive();
      return null;
    });
  }
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export class RecordingNotifier implements Notifier {
  readonly name = 'sandbox-notifier';
  readonly sent: (NotificationRequest & { messageId: string; at: Date })[] = [];
  private readonly idem = new IdempotencyStore();

  async send(req: NotificationRequest, idempotencyKey: string) {
    return this.idem.run(idempotencyKey, () => {
      const messageId = rid('sandbox-msg');
      this.sent.push({ ...req, messageId, at: new Date() });
      if (process.env.LOG_NOTIFICATIONS === '1') {
        console.log(`[notify:${req.channel}${req.critical ? ':critical' : ''}] ${req.customerId} — ${req.title}`);
      }
      return { delivered: true, messageId };
    });
  }

  forCustomer(customerId: string) {
    return this.sent.filter((n) => n.customerId === customerId);
  }

  clear(): void { this.sent.length = 0; }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Three feeds with different jitter and latency. Two agreeing plus one
 * laggard is exactly the situation the consolidator exists to handle.
 */
export const createSandboxRegistry = (
  market: MarketSimulator = sharedMarket(),
  custodyHydrator: CustodyHydrator | null = null,
): PartnerRegistry & {
  custody: SandboxCustodyProvider;
  notifier: RecordingNotifier;
  kyc: SandboxKycProvider;
  issuer: SandboxCardIssuer;
} => ({
  kyc: new SandboxKycProvider(),
  issuer: new SandboxCardIssuer(),
  custody: new SandboxCustodyProvider(market, custodyHydrator),
  marketData: [
    new SandboxMarketDataProvider('coinbase-sandbox', 5, market, 0),
    new SandboxMarketDataProvider('kraken-sandbox', 8, market, 1),
    new SandboxMarketDataProvider('refinitiv-sandbox', 12, market, 3),
  ],
  stablecoin: new SandboxStablecoinRail(market),
  lender: new SandboxLendingPartner(),
  notifier: new RecordingNotifier(),
});
