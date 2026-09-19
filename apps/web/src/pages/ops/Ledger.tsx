import { useEffect, useState } from 'react';
import { api, money } from '../../lib/api';
import type { ReconciliationView } from '../../lib/types';
import { Card, Empty, Spinner, Stat } from '../../components/ui';
import { PageHead } from '../../components/Layout';

export const Ledger = () => {
  const [recon, setRecon] = useState<ReconciliationView | null>(null);

  const load = async () => setRecon(await api.get<ReconciliationView>('/v1/admin/reconciliation'));
  useEffect(() => { void load(); }, []);

  if (!recon) return <Spinner />;
  const clean = recon.balanced && recon.breaks.length === 0;

  return (
    <>
      <PageHead
        title="Ledger"
        sub={`Reconciled ${new Date(recon.runAt).toLocaleString()}`}
        action={<button className="btn btn-sm" onClick={() => void load()}>Re-run</button>}
      />

      <div className="grid grid-4 mb">
        <Card><Stat label="Journal entries" value={String(recon.entryCount)} size="sm" /></Card>
        <Card><Stat label="Total debits" value={money(recon.totalDebits)} size="sm" /></Card>
        <Card><Stat label="Total credits" value={money(recon.totalCredits)} size="sm" /></Card>
        <Card>
          <div className="stat-label">Status</div>
          <div style={{ marginTop: 6 }}>
            <span className={`pill${clean ? ' pill-ok' : ' pill-bad'}`}>
              {clean ? 'Balanced' : `${recon.breaks.length} breaks`}
            </span>
          </div>
          <div className="stat-note">residual {money(recon.residual)}</div>
        </Card>
      </div>

      <div className="grid grid-2">
        <Card title="Income statement">
          <table>
            <tbody>
              {([
                ['Interchange revenue', recon.income.interchange],
                ['Interest revenue', recon.income.interest],
                ['FX revenue', recon.income.fx],
                ['Membership revenue', recon.income.membership],
                ['Total revenue', recon.income.totalRevenue],
              ] as const).map(([label, value]) => (
                <tr key={label} style={label === 'Total revenue' ? { fontWeight: 650 } : undefined}>
                  <td className={label === 'Total revenue' ? '' : 'muted'}>{label}</td>
                  <td className="num money">{money(value)}</td>
                </tr>
              ))}
              {([
                ['Rewards expense', recon.income.rewardsCost],
                ['Credit loss', recon.income.creditLoss],
                ['Liquidation cost', recon.income.liquidationCost],
                ['Total expense', recon.income.totalExpense],
              ] as const).map(([label, value]) => (
                <tr key={label} style={label === 'Total expense' ? { fontWeight: 650 } : undefined}>
                  <td className={label === 'Total expense' ? '' : 'muted'}>{label}</td>
                  <td className="num money">−{money(value)}</td>
                </tr>
              ))}
              <tr style={{ fontWeight: 650 }}>
                <td>Gross profit</td>
                <td className="num money" style={{
                  color: Number(recon.income.grossProfit) >= 0 ? 'var(--healthy)' : 'var(--remediation)',
                }}>{money(recon.income.grossProfit)}</td>
              </tr>
              <tr>
                <td className="muted">Gross margin</td>
                <td className="num money">{recon.income.grossMargin}%</td>
              </tr>
            </tbody>
          </table>
        </Card>

        <Card title="Reconciliation breaks">
          {recon.breaks.length === 0 ? (
            <Empty>
              Debits equal credits exactly, every journal entry balances, no idempotency key was
              posted twice, every facility agrees with the ledger, and suspense is clear.
            </Empty>
          ) : (
            <table>
              <thead><tr><th>Kind</th><th>Detail</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {recon.breaks.map((b, i) => (
                  <tr key={i}>
                    <td><span className="pill pill-bad">{b.kind.replace(/_/g, ' ')}</span></td>
                    <td className="small">{b.detail}</td>
                    <td className="num money">{b.amount ? money(b.amount) : '—'}</td>
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
