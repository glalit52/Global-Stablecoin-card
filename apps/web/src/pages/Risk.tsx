import { useEffect, useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { api, money, moneyCompact, percent } from '../lib/api';
import type { RiskView, StressView } from '../lib/types';
import { Card, HealthMeter, RiskLadder, Spinner, StateBadge, Stat, stateColor } from '../components/ui';
import { PageHead } from '../components/Layout';

export const Risk = () => {
  const [risk, setRisk] = useState<RiskView | null>(null);
  const [stress, setStress] = useState<StressView | null>(null);

  useEffect(() => {
    void (async () => {
      const [r, s] = await Promise.all([
        api.get<RiskView>('/v1/risk'),
        api.get<StressView>('/v1/risk/stress'),
      ]);
      setRisk(r); setStress(s);
    })();
  }, []);

  if (!risk || !stress) return <Spinner />;

  // Axis labels are truncated rather than wrapped: the full label is in the
  // table directly beneath, and an overlapping axis is worse than a short one.
  const shorten = (label: string) => {
    const base = label.replace(/\s*\(.*\)$/, '');
    return base.length > 22 ? `${base.slice(0, 21)}…` : base;
  };

  const chartData = stress.scenarios.map((s) => ({
    name: shorten(s.label),
    collateral: Number(s.eligibleCollateralValue),
    state: s.state,
    survives: s.survives,
  }));

  return (
    <>
      <PageHead
        title="Risk"
        sub={`Policy ${risk.policyVersion} · assessed ${new Date(risk.computedAt).toLocaleString()}`}
        action={<StateBadge state={risk.state} />}
      />

      <div className="grid grid-4 mb">
        <Card><Stat label="Portfolio health" value={`${risk.healthPercent}%`} size="sm" /></Card>
        <Card><Stat label="Loan-to-value" value={percent(risk.effectiveLtv)} size="sm" note="against eligible collateral" /></Card>
        <Card>
          <Stat
            label="Drawdown tolerance"
            value={stress.drawdownTolerance ? percent(String(Number(stress.drawdownTolerance) * 100), 0) : '—'}
            size="sm"
            note="fall your collateral could absorb"
          />
        </Card>
        <Card><Stat label="Safe to spend" value={money(risk.safeSpendCapacity)} size="sm" note="before the watch threshold" /></Card>
      </div>

      <div className="grid grid-2 mb">
        <Card title="Where you sit">
          <div className="stack">
            <HealthMeter percent={risk.healthPercent} state={risk.state} />
            <RiskLadder state={risk.state} thresholds={risk.thresholds} />
            <table style={{ marginTop: 8 }}>
              <tbody>
                <tr><td className="muted small">Debt</td><td className="num money">{money(risk.totalDebt)}</td></tr>
                <tr><td className="muted small">Eligible collateral</td><td className="num money">{money(risk.eligibleCollateralValue)}</td></tr>
                <tr><td className="muted small">Market value</td><td className="num money">{money(risk.totalMarketValue)}</td></tr>
                <tr><td className="muted small">Largest position</td><td className="num money">{percent(risk.topConcentration)}</td></tr>
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="What happens at each threshold">
          <table>
            <tbody>
              <tr>
                <td><span className="state state-watch">Watch</span></td>
                <td className="num muted small">{risk.thresholds.watch}% LTV</td>
                <td className="muted small">We tell you early. Nothing is restricted.</td>
              </tr>
              <tr>
                <td><span className="state state-restricted">Restricted</span></td>
                <td className="num muted small">{risk.thresholds.restricted}% LTV</td>
                <td className="muted small">New discretionary spending pauses. Essentials and recurring payments continue.</td>
              </tr>
              <tr>
                <td><span className="state state-remediation">Action required</span></td>
                <td className="num muted small">{risk.thresholds.remediation}% LTV</td>
                <td className="muted small">Add collateral or repay within 24 hours.</td>
              </tr>
              <tr>
                <td><span className="state state-liquidation">Liquidation</span></td>
                <td className="num muted small">{risk.thresholds.liquidation}% LTV</td>
                <td className="muted small">We may sell collateral to restore your account.</td>
              </tr>
            </tbody>
          </table>
          {risk.marginCall && (
            <p className="error-text mt">
              A margin call is open. Add {money(risk.marginCall.requiredAmount)} of collateral, or
              repay {money(risk.repaymentToTarget)}, by {new Date(risk.marginCall.deadline).toLocaleString()}.
            </p>
          )}
        </Card>
      </div>

      <Card title="Stress scenarios">
        <p className="muted small" style={{ marginTop: 0 }}>
          Your eligible collateral under each modelled shock, against your current
          balance of {money(risk.totalDebt)}.
        </p>
        <div style={{ height: 260, marginTop: 12 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 4, right: 8, bottom: 40, left: 8 }}>
              <CartesianGrid strokeDasharray="2 4" stroke="var(--border)" vertical={false} />
              <XAxis
                dataKey="name" angle={-28} textAnchor="end" height={64}
                tick={{ fill: 'var(--text-dim)', fontSize: 11 }}
                stroke="var(--border)"
              />
              <YAxis
                tickFormatter={(v: number) => moneyCompact(String(v))}
                tick={{ fill: 'var(--text-dim)', fontSize: 11 }}
                stroke="var(--border)"
              />
              <Tooltip
                contentStyle={{
                  background: 'var(--bg-raised)', border: '1px solid var(--border-strong)',
                  borderRadius: 10, fontSize: 13,
                }}
                labelStyle={{ color: 'var(--text)' }}
                formatter={(v: number) => [money(String(v)), 'Eligible collateral']}
              />
              <Bar dataKey="collateral" radius={[4, 4, 0, 0]}>
                {chartData.map((d, i) => (
                  <Cell key={i} fill={stateColor(d.state)} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        <table style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>Scenario</th>
              <th className="num">Eligible collateral</th>
              <th className="num">LTV</th>
              <th>Outcome</th>
              <th className="num">Shortfall</th>
            </tr>
          </thead>
          <tbody>
            {stress.scenarios.map((s) => (
              <tr key={s.id}>
                <td>{s.label}</td>
                <td className="num money">{money(s.eligibleCollateralValue)}</td>
                <td className="num money">
                  {s.effectiveLtv ? percent(String(Number(s.effectiveLtv) * 100)) : '—'}
                </td>
                <td><StateBadge state={s.state} /></td>
                <td className="num money">
                  {s.collateralShortfall === '0.00' ? '—' : money(s.collateralShortfall)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
};
