import { useEffect, useState } from 'react';
import { api, ApiError, dateTime, money } from '../../lib/api';
import { Card, Empty, ErrorText, Spinner } from '../../components/ui';
import { PageHead } from '../../components/Layout';

interface Liquidation {
  id: string; customer_id: string; legal_name: string; status: string;
  triggered_by: string; strategy: string; debt_before: string; collateral_before: string;
  plan: {
    lots: { symbol: string; quantity: string; netProceeds: string; reason: string }[];
    totalNetProceeds: string; projectedDebtAfter: string; sufficient: boolean;
  };
  total_net_proceeds: string; planned_at: string; executed_at: string | null;
}

export const Liquidations = () => {
  const [items, setItems] = useState<Liquidation[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = async () => {
    setLoading(true);
    const res = await api.get<{ liquidations: Liquidation[] }>('/v1/admin/liquidations');
    setItems(res.liquidations);
    setLoading(false);
  };

  useEffect(() => { void load(); }, []);

  /**
   * Executing a plan is not something one operator may do alone, so this files
   * an approval request. A second operator approves it, and the approval
   * handler runs the sale.
   */
  const requestExecution = async (liq: Liquidation) => {
    setBusy(liq.id); setError(''); setNotice('');
    try {
      await api.post('/v1/admin/approvals', {
        action: 'liquidation.execute',
        entityType: 'liquidation',
        entityId: liq.id,
        payload: {},
        justification: `Liquidation triggered by ${liq.triggered_by} for ${liq.legal_name}. Plan raises ${liq.plan.totalNetProceeds} against a balance of ${liq.debt_before}.`,
      });
      setNotice('Approval requested. A second operator must approve before any collateral is sold.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not request approval');
    } finally { setBusy(null); }
  };

  const cancel = async (id: string) => {
    setBusy(id); setError(''); setNotice('');
    try {
      await api.post(`/v1/admin/liquidations/${id}/cancel`, {
        reason: 'Cancelled from the operations console after review.',
      });
      await load();
      setNotice('Liquidation cancelled.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not cancel');
    } finally { setBusy(null); }
  };

  if (loading) return <Spinner />;

  return (
    <>
      <PageHead title="Liquidations" sub="Plans are generated automatically. Execution needs two operators." />

      {notice && <p className="success-text mb" role="status">{notice}</p>}
      <ErrorText>{error}</ErrorText>

      {items.length === 0 ? (
        <Card><Empty>No liquidations have been planned.</Empty></Card>
      ) : (
        <div className="stack">
          {items.map((l) => (
            <Card key={l.id}>
              <div className="between mb">
                <div>
                  <strong style={{ fontSize: 16 }}>{l.legal_name}</strong>
                  <div className="dim small">
                    {l.triggered_by.replace(/_/g, ' ')} · {l.strategy.replace('_', ' ')} · planned {dateTime(l.planned_at)}
                  </div>
                </div>
                <span className={`pill${l.status === 'executed' ? ' pill-ok' : l.status === 'cancelled' ? '' : ' pill-bad'}`}>
                  {l.status}
                </span>
              </div>

              <div className="grid grid-4 mb">
                <div><div className="stat-label">Debt before</div><div className="money">{money(l.debt_before)}</div></div>
                <div><div className="stat-label">Collateral before</div><div className="money">{money(l.collateral_before)}</div></div>
                <div><div className="stat-label">Plan raises</div><div className="money">{money(l.plan.totalNetProceeds)}</div></div>
                <div><div className="stat-label">Debt after</div><div className="money">{money(l.plan.projectedDebtAfter)}</div></div>
              </div>

              <table>
                <thead><tr><th>Sell</th><th className="num">Quantity</th><th className="num">Net proceeds</th><th>Why this asset</th></tr></thead>
                <tbody>
                  {l.plan.lots.map((lot, i) => (
                    <tr key={i}>
                      <td><strong>{lot.symbol}</strong></td>
                      <td className="num mono">{Number(lot.quantity).toLocaleString(undefined, { maximumFractionDigits: 8 })}</td>
                      <td className="num money">{money(lot.netProceeds)}</td>
                      <td className="dim small">{lot.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {!l.plan.sufficient && (
                <p className="error-text mt">
                  This plan does not fully restore the target loan-to-value. The remaining balance
                  would be unsecured.
                </p>
              )}

              {l.status === 'planned' && (
                <div className="row mt">
                  <button className="btn btn-danger" disabled={busy === l.id}
                    onClick={() => void requestExecution(l)}>
                    Request execution
                  </button>
                  <button className="btn" disabled={busy === l.id} onClick={() => void cancel(l.id)}>
                    Cancel
                  </button>
                </div>
              )}
              {l.status === 'executed' && (
                <p className="success-text mt">
                  Executed {dateTime(l.executed_at)} · {money(l.total_net_proceeds)} applied to the balance.
                </p>
              )}
            </Card>
          ))}
        </div>
      )}
    </>
  );
};
