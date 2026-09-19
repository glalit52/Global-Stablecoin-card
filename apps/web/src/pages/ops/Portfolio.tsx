import { useEffect, useState } from 'react';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { api, money, percent } from '../../lib/api';
import type { AdminMetrics, ReconciliationView, RiskState } from '../../lib/types';
import { Card, Spinner, Stat, stateColor } from '../../components/ui';
import { PageHead } from '../../components/Layout';

export const Portfolio = () => {
  const [metrics, setMetrics] = useState<AdminMetrics | null>(null);
  const [recon, setRecon] = useState<ReconciliationView | null>(null);

  useEffect(() => {
    void (async () => {
      const [m, r] = await Promise.all([
        api.get<AdminMetrics>('/v1/admin/metrics'),
        api.get<ReconciliationView>('/v1/admin/reconciliation'),
      ]);
      setMetrics(m); setRecon(r);
    })();
  }, []);

  if (!metrics || !recon) return <Spinner />;

  const distribution = Object.entries(metrics.riskDistribution).map(([state, count]) => ({
    name: state, value: count, state: state as RiskState,
  }));

  return (
    <>
      <PageHead title="Portfolio" sub="Programme health at a glance" />

      <div className="grid grid-4 mb">
        <Card><Stat label="Customers" value={String(metrics.portfolio.customers)} size="sm"
          note={`${metrics.portfolio.fundedCustomers} carrying a balance`} /></Card>
        <Card><Stat label="Credit extended" value={money(metrics.portfolio.totalCreditLimit)} size="sm" /></Card>
        <Card><Stat label="Outstanding" value={money(metrics.portfolio.totalOutstanding)} size="sm" /></Card>
        <Card><Stat label="Portfolio LTV" value={percent(metrics.portfolio.portfolioLtv)} size="sm"
          note={`against ${money(metrics.portfolio.totalEligibleCollateral)} collateral`} /></Card>
      </div>

      <div className="grid grid-3 mb">
        <Card title="Risk distribution">
          <div style={{ height: 190 }}>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={distribution} dataKey="value" nameKey="name"
                  innerRadius={48} outerRadius={78} paddingAngle={2} stroke="none">
                  {distribution.map((d) => <Cell key={d.name} fill={stateColor(d.state)} />)}
                </Pie>
                <Tooltip contentStyle={{
                  background: 'var(--bg-raised)', border: '1px solid var(--border-strong)',
                  borderRadius: 10, fontSize: 13,
                }} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div style={{ marginTop: 8 }}>
            {distribution.map((d) => (
              <div key={d.name} className="between small" style={{ padding: '3px 0' }}>
                <span className="row" style={{ gap: 8 }}>
                  <span style={{
                    width: 9, height: 9, borderRadius: '50%',
                    background: stateColor(d.state), display: 'inline-block',
                  }} />
                  <span style={{ textTransform: 'capitalize' }}>{d.name}</span>
                </span>
                <span className="money">{d.value}</span>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Payments, last 30 days">
          <table>
            <tbody>
              <tr><td className="muted">Volume</td><td className="num money">{money(metrics.payments.volume30d)}</td></tr>
              <tr><td className="muted">Transactions</td><td className="num money">{metrics.payments.transactions30d}</td></tr>
              <tr><td className="muted">Authorizations</td><td className="num money">{metrics.payments.authorizations30d}</td></tr>
              <tr><td className="muted">Approval rate</td><td className="num money">{metrics.payments.approvalRate}%</td></tr>
              <tr><td className="muted">Mean decision time</td><td className="num money">{metrics.payments.avgAuthLatencyMs} ms</td></tr>
              <tr><td className="muted">Points issued</td><td className="num money">{metrics.payments.pointsIssued30d}</td></tr>
            </tbody>
          </table>
        </Card>

        <Card title="Unit economics">
          <table>
            <tbody>
              <tr><td className="muted">Interchange</td><td className="num money">{money(recon.income.interchange)}</td></tr>
              <tr><td className="muted">Interest</td><td className="num money">{money(recon.income.interest)}</td></tr>
              <tr><td className="muted">FX margin</td><td className="num money">{money(recon.income.fx)}</td></tr>
              <tr><td className="muted">Membership</td><td className="num money">{money(recon.income.membership)}</td></tr>
              <tr><td className="muted">Rewards cost</td><td className="num money">−{money(recon.income.rewardsCost)}</td></tr>
              <tr><td className="muted">Credit losses</td><td className="num money">−{money(recon.income.creditLoss)}</td></tr>
              <tr><td className="muted">Liquidation cost</td><td className="num money">−{money(recon.income.liquidationCost)}</td></tr>
              <tr style={{ fontWeight: 650 }}>
                <td>Gross profit</td>
                <td className="num money" style={{
                  color: Number(recon.income.grossProfit) >= 0 ? 'var(--healthy)' : 'var(--remediation)',
                }}>{money(recon.income.grossProfit)}</td>
              </tr>
              <tr><td className="muted">Gross margin</td><td className="num money">{recon.income.grossMargin}%</td></tr>
            </tbody>
          </table>
        </Card>
      </div>

      <Card title="Ledger">
        <div className="between">
          <div className="row" style={{ gap: 26 }}>
            <Stat label="Journal entries" value={String(recon.entryCount)} size="sm" />
            <Stat label="Debits" value={money(recon.totalDebits)} size="sm" />
            <Stat label="Credits" value={money(recon.totalCredits)} size="sm" />
            <Stat label="Residual" value={money(recon.residual)} size="sm" />
          </div>
          <span className={`pill${recon.balanced && recon.breaks.length === 0 ? ' pill-ok' : ' pill-bad'}`}>
            {recon.balanced && recon.breaks.length === 0
              ? 'Balanced, no breaks'
              : `${recon.breaks.length} break${recon.breaks.length === 1 ? '' : 's'}`}
          </span>
        </div>
        {recon.breaks.length > 0 && (
          <table style={{ marginTop: 14 }}>
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
    </>
  );
};
