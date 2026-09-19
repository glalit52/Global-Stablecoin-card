/** Card lifecycle service (PRD §13.1). */
import type pg from 'pg';
import { getPolicy, Money, type CardControls, type CardForm, type CardStatus } from '@wealthcard/core';
import { money, query, queryOne, type Db } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { audit } from '../audit.js';
import type { AppContext } from '../context.js';

const serialiseControls = (c: CardControls): Record<string, unknown> => ({
  blockedMccs: c.blockedMccs,
  allowedCountries: c.allowedCountries,
  blockedCountries: c.blockedCountries,
  atmEnabled: c.atmEnabled,
  onlineEnabled: c.onlineEnabled,
  contactlessEnabled: c.contactlessEnabled,
  internationalEnabled: c.internationalEnabled,
  perTransactionLimit: c.perTransactionLimit?.toString() ?? null,
  dailyLimit: c.dailyLimit?.toString() ?? null,
  monthlyLimit: c.monthlyLimit?.toString() ?? null,
});

export const DEFAULT_CONTROLS: CardControls = {
  // Gambling, quasi-cash and crypto purchase MCCs are off by default. A
  // credit line secured by volatile collateral should not fund a casino, and
  // buying crypto on crypto-backed credit is leverage the product does not
  // intend to extend. Customers can enable them explicitly.
  blockedMccs: ['7995', '6051'],
  allowedCountries: [],
  blockedCountries: [],
  atmEnabled: false,
  onlineEnabled: true,
  contactlessEnabled: true,
  internationalEnabled: true,
  perTransactionLimit: null,
  dailyLimit: null,
  monthlyLimit: null,
};

export const issueCard = async (
  ctx: AppContext, db: Db, customerId: string, form: CardForm, nameOnCard: string,
): Promise<{ cardId: string; last4: string; status: CardStatus }> => {
  const customer = await queryOne<{ kyc_status: string; status: string }>(
    db, 'SELECT kyc_status, status FROM customers WHERE id = $1', [customerId],
  );
  if (!customer) throw notFound('Customer');
  if (customer.kyc_status !== 'approved') {
    throw badRequest('kyc_not_approved', 'Identity verification must be complete before a card can be issued');
  }
  if (customer.status === 'suspended' || customer.status === 'closed') {
    throw badRequest('account_not_active', 'This account cannot be issued a card');
  }

  const issued = await ctx.partners.issuer.issue(
    { customerId, form, network: 'visa', nameOnCard },
    `issue:${customerId}:${form}:${Date.now()}`,
  );

  const row = await queryOne<{ id: string }>(
    db,
    `INSERT INTO cards
       (customer_id, partner_card_id, token_reference, network, form, last4,
        exp_month, exp_year, status, controls)
     VALUES ($1,$2,$3,'visa',$4,$5,$6,$7,$8,$9)
     RETURNING id`,
    [customerId, issued.partnerCardId, issued.tokenReference, form, issued.last4,
     issued.expMonth, issued.expYear, issued.status, JSON.stringify(serialiseControls(DEFAULT_CONTROLS))],
  );

  await ctx.partners.issuer.updateControls(
    issued.partnerCardId, DEFAULT_CONTROLS, `controls:${row!.id}:initial`,
  );

  await audit(db, {
    actorType: 'customer', actorId: customerId,
    action: 'card.issued', entityType: 'card', entityId: row!.id,
    after: { form, last4: issued.last4, status: issued.status },
  });

  return { cardId: row!.id, last4: issued.last4, status: issued.status };
};

export const setCardStatus = async (
  ctx: AppContext, db: Db, cardId: string, customerId: string,
  status: CardStatus, actor: { type: 'customer' | 'operator'; id: string },
): Promise<void> => {
  const card = await queryOne<{ id: string; partner_card_id: string; status: CardStatus; customer_id: string }>(
    db, 'SELECT * FROM cards WHERE id = $1', [cardId],
  );
  if (!card) throw notFound('Card');
  if (card.customer_id !== customerId && actor.type === 'customer') throw notFound('Card');
  if (card.status === status) return;
  if (card.status === 'cancelled') throw conflict('card_cancelled', 'A cancelled card cannot change status');
  if (card.status === 'lost_stolen' && status !== 'cancelled') {
    throw conflict('card_terminal', 'A card reported lost or stolen cannot be reactivated');
  }

  await ctx.partners.issuer.setStatus(card.partner_card_id, status, `status:${cardId}:${status}:${Date.now()}`);
  await query(db, 'UPDATE cards SET status = $2, updated_at = now() WHERE id = $1', [cardId, status]);

  await audit(db, {
    actorType: actor.type, actorId: actor.id,
    action: `card.status_${status}`, entityType: 'card', entityId: cardId,
    before: { status: card.status }, after: { status },
  });
};

export const updateControls = async (
  ctx: AppContext, db: Db, cardId: string, customerId: string,
  patch: Partial<Record<keyof CardControls, unknown>>,
): Promise<CardControls> => {
  const card = await queryOne<{ partner_card_id: string; controls: Record<string, unknown>; customer_id: string }>(
    db, 'SELECT partner_card_id, controls, customer_id FROM cards WHERE id = $1', [cardId],
  );
  if (!card || card.customer_id !== customerId) throw notFound('Card');

  const merged = { ...card.controls, ...patch };
  const asMoney = (v: unknown) => (typeof v === 'string' && v.length > 0 ? money(v) : null);
  const controls: CardControls = {
    blockedMccs: (merged.blockedMccs as string[]) ?? [],
    allowedCountries: (merged.allowedCountries as string[]) ?? [],
    blockedCountries: (merged.blockedCountries as string[]) ?? [],
    atmEnabled: merged.atmEnabled !== false,
    onlineEnabled: merged.onlineEnabled !== false,
    contactlessEnabled: merged.contactlessEnabled !== false,
    internationalEnabled: merged.internationalEnabled !== false,
    perTransactionLimit: asMoney(merged.perTransactionLimit),
    dailyLimit: asMoney(merged.dailyLimit),
    monthlyLimit: asMoney(merged.monthlyLimit),
  };

  await ctx.partners.issuer.updateControls(card.partner_card_id, controls, `controls:${cardId}:${Date.now()}`);
  await query(
    db, 'UPDATE cards SET controls = $2, updated_at = now() WHERE id = $1',
    [cardId, JSON.stringify(serialiseControls(controls))],
  );

  await audit(db, {
    actorType: 'customer', actorId: customerId,
    action: 'card.controls_updated', entityType: 'card', entityId: cardId,
    before: card.controls, after: serialiseControls(controls),
  });

  return controls;
};

/** Reveal PAN and CVV. Always audited; the caller must have passed step-up. */
export const revealCard = async (
  ctx: AppContext, db: Db, cardId: string, customerId: string,
): Promise<{ pan: string; cvv: string; expMonth: number; expYear: number }> => {
  const card = await queryOne<{ partner_card_id: string; customer_id: string; status: CardStatus }>(
    db, 'SELECT partner_card_id, customer_id, status FROM cards WHERE id = $1', [cardId],
  );
  if (!card || card.customer_id !== customerId) throw notFound('Card');
  if (card.status === 'cancelled' || card.status === 'lost_stolen') {
    throw conflict('card_unavailable', 'This card can no longer be displayed');
  }

  const secrets = await ctx.partners.issuer.reveal(card.partner_card_id, customerId);
  await audit(db, {
    actorType: 'customer', actorId: customerId,
    action: 'card.revealed', entityType: 'card', entityId: cardId,
    after: { at: ctx.now().toISOString() },
  });
  return secrets;
};

export const provisionWallet = async (
  ctx: AppContext, db: Db, cardId: string, customerId: string,
  wallet: 'apple_pay' | 'google_pay',
): Promise<{ activationData: string }> => {
  const card = await queryOne<{ partner_card_id: string; customer_id: string; wallets: string[] }>(
    db, 'SELECT partner_card_id, customer_id, wallets FROM cards WHERE id = $1', [cardId],
  );
  if (!card || card.customer_id !== customerId) throw notFound('Card');

  const result = await ctx.partners.issuer.provisionWallet(
    card.partner_card_id, wallet, `wallet:${cardId}:${wallet}`,
  );
  if (!card.wallets.includes(wallet)) {
    await query(
      db, 'UPDATE cards SET wallets = array_append(wallets, $2), updated_at = now() WHERE id = $1',
      [cardId, wallet],
    );
  }
  await audit(db, {
    actorType: 'customer', actorId: customerId,
    action: 'card.wallet_provisioned', entityType: 'card', entityId: cardId,
    after: { wallet },
  });
  return result;
};

export const listCards = async (db: Db, customerId: string) => {
  const rows = await query<{
    id: string; form: CardForm; last4: string; exp_month: number; exp_year: number;
    status: CardStatus; network: string; controls: Record<string, unknown>; wallets: string[];
    created_at: Date;
  }>(db, 'SELECT * FROM cards WHERE customer_id = $1 ORDER BY created_at', [customerId]);

  return rows.map((r) => ({
    id: r.id, form: r.form, last4: r.last4,
    expMonth: r.exp_month, expYear: r.exp_year,
    status: r.status, network: r.network,
    controls: r.controls, wallets: r.wallets,
    createdAt: r.created_at.toISOString(),
  }));
};

export { getPolicy, Money };
