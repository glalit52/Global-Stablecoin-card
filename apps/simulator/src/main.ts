/**
 * Merchant and market simulator.
 *
 * Drives a running API the way the world would: cards tapped at real merchant
 * categories, occasional declines, and market moves underneath. Useful for
 * demos, for watching the risk loop react, and for putting enough load on the
 * authorization path to see its latency under concurrency.
 *
 *   pnpm simulate                        steady activity
 *   pnpm simulate -- --tps 5             five transactions a second
 *   pnpm simulate -- --crash BTC:-45     shock the market, then continue
 *   pnpm simulate -- --once              one round, then exit
 */

const API = process.env.API_URL ?? 'http://127.0.0.1:4000';

interface Merchant {
  name: string; mcc: string; country: string; currency: string;
  min: number; max: number;
  entryMode: 'contactless' | 'chip' | 'ecommerce' | 'atm';
  weight: number;
}

const MERCHANTS: Merchant[] = [
  { name: 'Whole Foods Market', mcc: '5411', country: 'US', currency: 'USD', min: 40, max: 320, entryMode: 'contactless', weight: 18 },
  { name: "Trader Joe's", mcc: '5411', country: 'US', currency: 'USD', min: 25, max: 180, entryMode: 'contactless', weight: 12 },
  { name: 'Shell', mcc: '5541', country: 'US', currency: 'USD', min: 35, max: 120, entryMode: 'contactless', weight: 10 },
  { name: 'Tesla Supercharger', mcc: '5552', country: 'US', currency: 'USD', min: 12, max: 60, entryMode: 'contactless', weight: 6 },
  { name: 'Blue Bottle Coffee', mcc: '5812', country: 'US', currency: 'USD', min: 6, max: 28, entryMode: 'contactless', weight: 14 },
  { name: 'Nobu', mcc: '5812', country: 'US', currency: 'USD', min: 180, max: 900, entryMode: 'chip', weight: 5 },
  { name: 'Uber', mcc: '4121', country: 'US', currency: 'USD', min: 11, max: 85, entryMode: 'ecommerce', weight: 11 },
  { name: 'Apple', mcc: '5732', country: 'US', currency: 'USD', min: 99, max: 3200, entryMode: 'ecommerce', weight: 5 },
  { name: 'Four Seasons George V', mcc: '7011', country: 'FR', currency: 'EUR', min: 600, max: 2400, entryMode: 'chip', weight: 3 },
  { name: 'Emirates', mcc: '3001', country: 'AE', currency: 'USD', min: 900, max: 7500, entryMode: 'ecommerce', weight: 3 },
  { name: 'Harrods', mcc: '5311', country: 'GB', currency: 'GBP', min: 200, max: 3000, entryMode: 'chip', weight: 3 },
  { name: 'Netflix', mcc: '5815', country: 'US', currency: 'USD', min: 16, max: 25, entryMode: 'ecommerce', weight: 6 },
  // Included deliberately: this MCC demands step-up, so the simulator
  // produces a realistic share of declines rather than a clean success rate.
  { name: 'Crypto Exchange', mcc: '6051', country: 'US', currency: 'USD', min: 500, max: 5000, entryMode: 'ecommerce', weight: 2 },
];

const TOTAL_WEIGHT = MERCHANTS.reduce((a, m) => a + m.weight, 0);

const pickMerchant = (): Merchant => {
  let roll = Math.random() * TOTAL_WEIGHT;
  for (const m of MERCHANTS) {
    roll -= m.weight;
    if (roll <= 0) return m;
  }
  return MERCHANTS[0]!;
};

const arg = (flag: string): string | null => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
};

const post = async <T>(path: string, body: unknown, token?: string): Promise<{ status: number; body: T }> => {
  const response = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as T };
};

interface Cardholder { customerId: string; name: string; cardId: string; token: string }

const loadCardholders = async (): Promise<Cardholder[]> => {
  const operator = await post<{ token: string }>('/v1/operator/login', {
    email: 'risk@wealthcard.example', password: 'wealth-demo-2026!',
  });
  if (operator.status !== 200) {
    throw new Error('Could not sign in as an operator. Has the database been seeded?');
  }

  const listed = await fetch(`${API}/v1/admin/customers?limit=100`, {
    headers: { authorization: `Bearer ${operator.body.token}` },
  });
  const { customers } = await listed.json() as { customers: { id: string; email: string; legalName: string }[] };

  const holders: Cardholder[] = [];
  for (const c of customers) {
    const session = await post<{ token: string }>('/v1/auth/login', {
      email: c.email, password: 'wealth-demo-2026!',
    });
    if (session.status !== 200) continue;

    const cards = await fetch(`${API}/v1/cards`, {
      headers: { authorization: `Bearer ${session.body.token}` },
    });
    const { cards: list } = await cards.json() as { cards: { id: string; status: string }[] };
    const active = list.find((card) => card.status === 'active');
    if (!active) continue;

    holders.push({ customerId: c.id, name: c.legalName, cardId: active.id, token: session.body.token });
  }
  return holders;
};

interface AuthResponse {
  approved: boolean; declineCode: string | null; declineReason: string | null;
  billingAmount: string; latencyMs: number;
}

const spend = async (holder: Cardholder): Promise<void> => {
  const merchant = pickMerchant();
  const amount = (merchant.min + Math.random() * (merchant.max - merchant.min)).toFixed(2);
  const requestId = `sim-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  const result = await post<AuthResponse>('/v1/card/authorize', {
    requestId,
    cardId: holder.cardId,
    amount,
    currency: merchant.currency,
    merchantId: `m_${merchant.name.toLowerCase().replace(/\W+/g, '_')}`,
    merchantName: merchant.name,
    mcc: merchant.mcc,
    merchantCountry: merchant.country,
    entryMode: merchant.entryMode,
    isRecurring: merchant.mcc === '5815',
  });

  const who = holder.name.padEnd(18);
  if (result.body.approved) {
    // Most authorizations settle; a few are left outstanding so the hold
    // lifecycle and its expiry path get exercised too.
    if (Math.random() > 0.12) await post('/v1/card/settle', { requestId });
    console.log(
      `  ✓ ${who} ${merchant.name.padEnd(24)} ${amount.padStart(9)} ${merchant.currency}  ${String(result.body.latencyMs).padStart(3)}ms`,
    );
  } else {
    console.log(
      `  ✗ ${who} ${merchant.name.padEnd(24)} ${amount.padStart(9)} ${merchant.currency}  ${result.body.declineCode ?? 'declined'}`,
    );
  }
};

const main = async (): Promise<void> => {
  const tps = Number(arg('--tps') ?? 2);
  const once = process.argv.includes('--once');
  const crash = arg('--crash');

  console.log(`Simulator against ${API}`);

  const holders = await loadCardholders();
  if (holders.length === 0) {
    console.error('No active cards found. Run `pnpm bootstrap` first.');
    process.exitCode = 1;
    return;
  }
  console.log(`${holders.length} cardholders: ${holders.map((h) => h.name).join(', ')}\n`);

  if (crash) {
    const [symbol, change] = crash.split(':');
    const result = await post<{ newPrice: string; results: { state: string }[] }>(
      '/v1/market/scenario', { symbol, changePercent: change },
    );
    console.log(`Market: ${symbol} now ${result.body.newPrice}`);
    for (const r of result.body.results) console.log(`  customer now ${r.state}`);
    console.log('');
  }

  let running = true;
  process.on('SIGINT', () => { running = false; });

  let round = 0;
  while (running) {
    round += 1;
    // Fire a round concurrently: the facility row lock is the thing worth
    // exercising, and it only matters under simultaneous requests.
    await Promise.all(
      Array.from({ length: Math.max(1, Math.round(tps)) }, () =>
        spend(holders[Math.floor(Math.random() * holders.length)]!)),
    );

    if (once) break;
    if (round % 10 === 0) {
      const market = await fetch(`${API}/v1/market`).then((r) => r.json()) as { prices: Record<string, string> };
      console.log(`  — BTC ${market.prices.BTC} —`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  console.log('\nStopped.');
};

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

// This file has no imports, so the explicit export marks it as a module
// rather than a script sharing the global scope.
export {};
