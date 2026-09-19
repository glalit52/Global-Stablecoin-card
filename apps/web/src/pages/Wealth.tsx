import { useEffect, useState } from 'react';
import { api, money, percent, ApiError, dateTime } from '../lib/api';
import type { CreditView, RiskView, WealthView } from '../lib/types';
import { Card, ErrorText, Spinner, Stat } from '../components/ui';
import { PageHead } from '../components/Layout';

export const Wealth = () => {
  const [wealth, setWealth] = useState<WealthView | null>(null);
  const [risk, setRisk] = useState<RiskView | null>(null);
  const [credit, setCredit] = useState<CreditView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [repayAmount, setRepayAmount] = useState('');
  const [notice, setNotice] = useState('');

  const load = async () => {
    const [w, r, c] = await Promise.all([
      api.get<WealthView>('/v1/wealth'),
      api.get<RiskView>('/v1/risk'),
      api.get<CreditView>('/v1/credit'),
    ]);
    setWealth(w); setRisk(r); setCredit(c);
  };

  useEffect(() => { void load(); }, []);

  const pledge = async (assetId: string) => {
    setBusy(assetId); setError(''); setNotice('');
    try {
      await api.post('/v1/collateral/add', { assetId });
      await load();
      setNotice('Collateral added. Your limit has been recalculated.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add collateral');
    } finally { setBusy(null); }
  };

  const release = async (assetId: string) => {
    setBusy(assetId); setError(''); setNotice('');
    try {
      await api.post('/v1/collateral/release', { assetId });
      await load();
      setNotice('Collateral released.');
    } catch (err) {
      // A refusal here is the risk engine protecting the customer, so the
      // reason matters more than the fact of the failure.
      setError(err instanceof ApiError ? err.message : 'Could not release collateral');
    } finally { setBusy(null); }
  };

  const repay = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy('repay'); setError(''); setNotice('');
    try {
      const res = await api.post<{ balanceAfter: string; riskState: string }>('/v1/repayment', {
        amount: repayAmount,
        source: 'fiat',
        idempotencyKey: `web-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      });
      setRepayAmount('');
      await load();
      setNotice(`Payment applied. Your balance is now ${money(res.balanceAfter)}.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not process the payment');
    } finally { setBusy(null); }
  };

  if (!wealth || !risk || !credit) return <Spinner />;

  return (
    <>
      <PageHead
        title="Wealth"
        sub={`Valued ${dateTime(wealth.computedAt)} · policy ${risk.policyVersion}`}
      />

      <div className="grid grid-4 mb">
        <Card><Stat label="Total wealth" value={money(wealth.totalWealth)} size="sm" /></Card>
        <Card><Stat label="Eligible collateral" value={money(wealth.eligibleCollateral)} size="sm" /></Card>
        <Card><Stat label="Releasable" value={money(risk.withdrawableCollateral)} size="sm" note="while staying healthy" /></Card>
        <Card><Stat label="Largest position" value={percent(risk.topConcentration)} size="sm" note="of eligible collateral" /></Card>
      </div>

      {notice && <p className="success-text mb" role="status">{notice}</p>}
      <ErrorText>{error}</ErrorText>

      <div className="grid grid-2 mb">
        <Card title="Repay">
          <form onSubmit={repay}>
            <div className="field">
              <label htmlFor="repay">Amount</label>
              <input
                id="repay" className="input" inputMode="decimal"
                placeholder={risk.repaymentToTarget !== '0.00' ? risk.repaymentToTarget : '0.00'}
                value={repayAmount} onChange={(e) => setRepayAmount(e.target.value)}
                pattern="^\d+(\.\d{1,2})?$" required
              />
              <p className="hint">
                You owe {money(credit.currentBalance)}.
                {risk.repaymentToTarget !== '0.00' && (
                  <> Paying {money(risk.repaymentToTarget)} restores your target loan-to-value.</>
                )}
              </p>
            </div>
            <div className="row">
              <button className="btn btn-primary" disabled={busy === 'repay' || !repayAmount}>
                {busy === 'repay' ? 'Processing…' : 'Pay now'}
              </button>
              {risk.repaymentToTarget !== '0.00' && (
                <button type="button" className="btn btn-sm"
                  onClick={() => setRepayAmount(risk.repaymentToTarget)}>
                  Pay {money(risk.repaymentToTarget)}
                </button>
              )}
              {credit.currentBalance !== '0.00' && (
                <button type="button" className="btn btn-sm"
                  onClick={() => setRepayAmount(credit.currentBalance)}>
                  Pay in full
                </button>
              )}
            </div>
          </form>
        </Card>

        <Card title="What your collateral supports">
          <div className="stack">
            <div className="between">
              <span className="muted small">Market value of pledged assets</span>
              <span className="money">{money(risk.totalMarketValue)}</span>
            </div>
            <div className="between">
              <span className="muted small">After haircuts (eligible)</span>
              <span className="money">{money(risk.eligibleCollateralValue)}</span>
            </div>
            <div className="between">
              <span className="muted small">Credit limit at the advance rate</span>
              <span className="money">{money(credit.creditLimit)}</span>
            </div>
            <div className="between">
              <span className="muted small">Currently drawn</span>
              <span className="money">{money(risk.totalDebt)}</span>
            </div>
            <p className="small dim" style={{ margin: 0 }}>
              A haircut is the discount we apply to an asset's market value before lending
              against it. It absorbs the price move we would face between a margin call and a sale.
            </p>
          </div>
        </Card>
      </div>

      <Card title="Positions">
        <table>
          <thead>
            <tr>
              <th>Asset</th>
              <th className="num">Quantity</th>
              <th className="num">Market value</th>
              <th className="num">Haircut</th>
              <th className="num">Eligible value</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {wealth.positions.map((p) => {
              const pledged = !p.ineligibilityReasons.some((r) => r.code === 'not_pledged');
              return (
                <tr key={p.assetId}>
                  <td>
                    <strong>{p.symbol}</strong>
                    <div className="dim small">{p.assetClass.replace('_', ' ').toLowerCase()}</div>
                  </td>
                  <td className="num mono">{Number(p.quantity).toLocaleString(undefined, { maximumFractionDigits: 8 })}</td>
                  <td className="num money">{money(p.marketValue)}</td>
                  <td className="num money">{p.eligible ? percent(p.haircut) : '—'}</td>
                  <td className="num money">{p.eligible ? money(p.eligibleValue) : '—'}</td>
                  <td>
                    {p.eligible ? (
                      <span className="pill pill-ok">Collateral</span>
                    ) : (
                      <div>
                        <span className="pill">Not counted</span>
                        <div className="dim small" style={{ marginTop: 4, maxWidth: 280 }}>
                          {p.ineligibilityReasons.map((r) => r.explanation).join('. ')}
                        </div>
                      </div>
                    )}
                  </td>
                  <td className="num">
                    {pledged ? (
                      <button className="btn btn-sm" disabled={busy === p.assetId}
                        onClick={() => void release(p.assetId)}>
                        Release
                      </button>
                    ) : (
                      <button className="btn btn-sm btn-primary" disabled={busy === p.assetId}
                        onClick={() => void pledge(p.assetId)}>
                        Pledge
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {wealth.unpricedSymbols.length > 0 && (
          <p className="hint">
            No price available for {wealth.unpricedSymbols.join(', ')}. These are excluded from
            collateral until pricing is restored.
          </p>
        )}
      </Card>
    </>
  );
};
