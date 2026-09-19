import { useEffect, useState } from 'react';
import { api, money, ApiError } from '../lib/api';
import type { CardView, CreditView } from '../lib/types';
import { Card, ErrorText, Spinner, Stat } from '../components/ui';
import { PageHead } from '../components/Layout';

const TIER_LABEL: Record<string, string> = {
  WEALTH: 'Wealth', WEALTH_PLUS: 'Wealth+', PRIVATE: 'Private', ULTRA: 'Ultra',
};

export const CardPage = () => {
  const [cards, setCards] = useState<CardView[]>([]);
  const [credit, setCredit] = useState<CreditView | null>(null);
  const [tier, setTier] = useState('WEALTH');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = async () => {
    const [c, cr, me] = await Promise.all([
      api.get<{ cards: CardView[] }>('/v1/cards'),
      api.get<CreditView>('/v1/credit'),
      api.get<{ tier: string }>('/v1/auth/me'),
    ]);
    setCards(c.cards); setCredit(cr); setTier(me.tier);
  };

  useEffect(() => { void load(); }, []);

  const setStatus = async (cardId: string, status: string) => {
    setBusy(cardId); setError(''); setNotice('');
    try {
      await api.post(`/v1/cards/${cardId}/status`, { status });
      await load();
      setNotice(status === 'frozen' ? 'Card frozen. No new transactions will be approved.' : 'Card unfrozen.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update the card');
    } finally { setBusy(null); }
  };

  const issue = async (form: 'virtual' | 'physical') => {
    setBusy(form); setError(''); setNotice('');
    try {
      await api.post('/v1/cards', { form, nameOnCard: 'CARDHOLDER' });
      await load();
      setNotice(form === 'virtual'
        ? 'Virtual card issued and ready to use.'
        : 'Physical card ordered. Activate it when it arrives.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not issue a card');
    } finally { setBusy(null); }
  };

  const toggleControl = async (cardId: string, key: string, value: boolean) => {
    setBusy(cardId); setError('');
    try {
      await api.patch(`/v1/cards/${cardId}/controls`, { [key]: value });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update card controls');
    } finally { setBusy(null); }
  };

  if (!credit) return <Spinner />;

  return (
    <>
      <PageHead title="Card" sub="Spend at any merchant that takes Visa. Your assets stay yours." />

      {notice && <p className="success-text mb" role="status">{notice}</p>}
      <ErrorText>{error}</ErrorText>

      <div className="grid grid-3 mb">
        <Card><Stat label="Available" value={money(credit.availableCredit)} size="sm" /></Card>
        <Card><Stat label="Balance" value={money(credit.currentBalance)} size="sm" /></Card>
        <Card><Stat label="Rate" value={`${credit.apr}%`} size="sm" note="variable APR on revolving balances" /></Card>
      </div>

      {cards.length === 0 && (
        <Card title="Get your card">
          <p className="muted">You have no cards yet. A virtual card works immediately.</p>
          <div className="row mt">
            <button className="btn btn-primary" disabled={busy === 'virtual'} onClick={() => void issue('virtual')}>
              Issue virtual card
            </button>
            <button className="btn" disabled={busy === 'physical'} onClick={() => void issue('physical')}>
              Order physical card
            </button>
          </div>
        </Card>
      )}

      <div className="grid grid-2">
        {cards.map((card) => {
          const controls = card.controls as Record<string, unknown>;
          const frozen = card.status === 'frozen';
          return (
            <Card key={card.id}>
              <div className={`wealth-card${frozen ? ' frozen' : ''}`}>
                <div className="between">
                  <span className="card-tier">{TIER_LABEL[tier] ?? tier}</span>
                  <span className="small dim">{card.form === 'virtual' ? 'Virtual' : 'Physical'}</span>
                </div>
                <div className="card-number">•••• •••• •••• {card.last4}</div>
                <div className="card-foot">
                  <div>
                    <div className="card-holder">Expires</div>
                    <div className="mono">
                      {String(card.expMonth).padStart(2, '0')}/{String(card.expYear).slice(-2)}
                    </div>
                  </div>
                  <span className="card-network">VISA</span>
                </div>
              </div>

              <div className="between mt">
                <span className={`pill${card.status === 'active' ? ' pill-ok' : frozen ? ' pill-bad' : ''}`}>
                  {card.status.replace('_', ' ')}
                </span>
                <div className="row">
                  {card.status === 'inactive' && (
                    <button className="btn btn-sm btn-primary" disabled={busy === card.id}
                      onClick={() => void setStatus(card.id, 'active')}>
                      Activate
                    </button>
                  )}
                  {card.status === 'active' && (
                    <button className="btn btn-sm" disabled={busy === card.id}
                      onClick={() => void setStatus(card.id, 'frozen')}>
                      Freeze
                    </button>
                  )}
                  {frozen && (
                    <button className="btn btn-sm btn-primary" disabled={busy === card.id}
                      onClick={() => void setStatus(card.id, 'active')}>
                      Unfreeze
                    </button>
                  )}
                  <button className="btn btn-sm btn-danger" disabled={busy === card.id}
                    onClick={() => void setStatus(card.id, 'lost_stolen')}>
                    Report lost
                  </button>
                </div>
              </div>

              <div className="mt">
                <h3 className="card-title">Controls</h3>
                {([
                  ['contactlessEnabled', 'Contactless'],
                  ['onlineEnabled', 'Online purchases'],
                  ['internationalEnabled', 'International'],
                  ['atmEnabled', 'ATM withdrawals'],
                ] as const).map(([key, label]) => (
                  <div className="toggle-row" key={key}>
                    <span className="small">{label}</span>
                    <button
                      className="toggle"
                      data-on={controls[key] !== false}
                      aria-pressed={controls[key] !== false}
                      aria-label={label}
                      disabled={busy === card.id}
                      onClick={() => void toggleControl(card.id, key, controls[key] === false)}
                    />
                  </div>
                ))}
                <p className="hint">
                  Gambling and crypto-purchase merchants are blocked by default on every card.
                </p>
              </div>
            </Card>
          );
        })}
      </div>

      {cards.length > 0 && cards.length < 3 && (
        <div className="row mt">
          <button className="btn btn-sm" disabled={busy === 'virtual'} onClick={() => void issue('virtual')}>
            Issue another virtual card
          </button>
        </div>
      )}
    </>
  );
};
