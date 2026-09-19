import { useEffect, useState } from 'react';
import { api, dateTime, money, points } from '../lib/api';
import type { DeclinedView, TransactionView } from '../lib/types';
import { Card, Empty, Spinner } from '../components/ui';
import { PageHead } from '../components/Layout';

const CATEGORY_ICON: Record<string, string> = {
  groceries: '◍', fuel_ev: '⏚', dining: '◐', travel: '✈', hotels: '⌂',
  lounges: '❖', retail: '◫', ecommerce: '⊞', subscriptions: '↻',
  utilities: '⌁', transit: '⊶', cash_advance: '⊙', crypto: '◈', other: '·',
};

export const Activity = () => {
  const [transactions, setTransactions] = useState<TransactionView[]>([]);
  const [declined, setDeclined] = useState<DeclinedView[]>([]);
  const [showDeclined, setShowDeclined] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      const res = await api.get<{ transactions: TransactionView[]; declined: DeclinedView[] }>(
        '/v1/transactions?limit=100&includeDeclined=true',
      );
      setTransactions(res.transactions);
      setDeclined(res.declined);
      setLoading(false);
    })();
  }, []);

  if (loading) return <Spinner />;

  return (
    <>
      <PageHead
        title="Activity"
        sub={`${transactions.length} transactions`}
        action={
          <button className="btn btn-sm" onClick={() => setShowDeclined(!showDeclined)}>
            {showDeclined ? 'Hide declines' : `Show declines (${declined.length})`}
          </button>
        }
      />

      {showDeclined && (
        <Card title="Declined" >
          {declined.length === 0 ? <Empty>No declined transactions.</Empty> : (
            <table>
              <thead>
                <tr><th>Merchant</th><th>Reason</th><th className="num">Amount</th><th className="num">When</th></tr>
              </thead>
              <tbody>
                {declined.map((d) => (
                  <tr key={d.requestId}>
                    <td>
                      <strong>{d.merchantName}</strong>
                      <div className="dim small">{d.merchantCountry} · MCC {d.mcc}</div>
                    </td>
                    <td>
                      <span className="pill pill-bad">{d.declineCode?.split('_')[0] ?? '—'}</span>
                      <div className="dim small" style={{ marginTop: 4, maxWidth: 340 }}>{d.declineReason}</div>
                    </td>
                    <td className="num money">{money(d.amount, d.currency)}</td>
                    <td className="num dim small">{dateTime(d.declinedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}

      <div style={{ marginTop: showDeclined ? 16 : 0 }}>
        <Card title="Transactions">
          {transactions.length === 0 ? <Empty>No transactions yet.</Empty> : (
            <table>
              <thead>
                <tr>
                  <th>Merchant</th>
                  <th>Category</th>
                  <th className="num">Amount</th>
                  <th className="num">Points</th>
                  <th className="num">When</th>
                </tr>
              </thead>
              <tbody>
                {transactions.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <div className="row" style={{ gap: 10 }}>
                        <span aria-hidden="true" className="dim" style={{ fontSize: 16 }}>
                          {CATEGORY_ICON[t.category] ?? '·'}
                        </span>
                        <div>
                          <strong>{t.merchantName}</strong>
                          <div className="dim small">
                            {t.merchantCountry}
                            {t.status !== 'settled' && ` · ${t.status}`}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="muted small">{t.category.replace('_', ' ')}</td>
                    <td className="num">
                      <span className="money">{money(t.billingAmount)}</span>
                      {t.originalCurrency !== 'USD' && (
                        <div className="dim small">
                          {money(t.originalAmount, t.originalCurrency)} at {Number(t.fxRate).toFixed(4)}
                          {t.fxFee !== '0.00' && ` · fee ${money(t.fxFee)}`}
                        </div>
                      )}
                    </td>
                    <td className="num money">{points(t.pointsEarned)}</td>
                    <td className="num dim small">{dateTime(t.settledAt ?? t.authorizedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </>
  );
};
