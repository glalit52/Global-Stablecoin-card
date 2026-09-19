import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, money, percent } from '../lib/api';
import type { AlertView, CreditView, Me, RiskView, WealthView } from '../lib/types';
import { Banner, Card, HealthMeter, RiskLadder, Spinner, StateBadge, Stat } from '../components/ui';
import { PageHead } from '../components/Layout';

export const Overview = () => {
  const [me, setMe] = useState<Me | null>(null);
  const [credit, setCredit] = useState<CreditView | null>(null);
  const [risk, setRisk] = useState<RiskView | null>(null);
  const [wealth, setWealth] = useState<WealthView | null>(null);
  const [alerts, setAlerts] = useState<AlertView[]>([]);

  useEffect(() => {
    void (async () => {
      const [m, c, r, w, a] = await Promise.all([
        api.get<Me>('/v1/auth/me'),
        api.get<CreditView>('/v1/credit'),
        api.get<RiskView>('/v1/risk'),
        api.get<WealthView>('/v1/wealth'),
        api.get<{ alerts: AlertView[] }>('/v1/alerts'),
      ]);
      setMe(m); setCredit(c); setRisk(r); setWealth(w); setAlerts(a.alerts);
    })();
  }, []);

  if (!me || !credit || !risk || !wealth) return <Spinner />;

  const critical = alerts.find((a) => a.severity === 'critical');
  const firstName = me.legalName.split(' ')[0];

  return (
    <>
      <PageHead
        title={`Good day, ${firstName}`}
        sub={`${me.tier.replace('_', ' ')} member since ${new Date(me.memberSince).getFullYear()}`}
        action={<StateBadge state={risk.state} />}
      />

      {critical && (
        <Banner
          icon="⚠"
          title={critical.title}
          action={
            risk.marginCall
              ? <Link className="btn btn-sm btn-primary" to="/wealth">Add collateral or repay</Link>
              : undefined
          }
        >
          {critical.body}
        </Banner>
      )}

      {risk.degraded && !critical && (
        <Banner icon="◷" title="Some pricing is degraded">
          One or more of your holdings has no recent verified price, so its collateral value is
          suspended until pricing recovers. Your figures are deliberately conservative meanwhile.
        </Banner>
      )}

      <div className="grid grid-4 mb">
        <Card>
          <Stat
            label="Available to spend"
            value={money(credit.availableCredit)}
            note={
              credit.safeSpendCapacity !== credit.availableCredit
                ? <>We suggest staying under <strong>{money(credit.safeSpendCapacity)}</strong></>
                : `of ${money(credit.creditLimit)} limit`
            }
          />
        </Card>
        <Card>
          <Stat
            label="Current balance"
            value={money(credit.currentBalance)}
            note={
              credit.pendingAuthorizations !== '0.00'
                ? `plus ${money(credit.pendingAuthorizations)} pending`
                : `${percent(credit.utilization)} of your limit`
            }
          />
        </Card>
        <Card>
          <Stat
            label="Connected wealth"
            value={money(wealth.totalWealth)}
            note={`${money(wealth.eligibleCollateral)} eligible as collateral`}
          />
        </Card>
        <Card>
          <Stat label="Portfolio health" value={`${risk.healthPercent}%`} />
          <div className="mt"><HealthMeter percent={risk.healthPercent} state={risk.state} /></div>
        </Card>
      </div>

      <div className="grid grid-2 mb">
        <Card title="Your position">
          <div className="stack">
            <div className="between">
              <span className="muted">Loan-to-value</span>
              <strong className="money">{percent(risk.effectiveLtv)}</strong>
            </div>
            <RiskLadder state={risk.state} thresholds={risk.thresholds} />
            <p className="small muted" style={{ margin: '4px 0 0' }}>
              You are borrowing {money(risk.totalDebt)} against {money(risk.eligibleCollateralValue)} of
              eligible collateral. We would need to act at {risk.thresholds.liquidation}%.
            </p>
            {risk.withdrawableCollateral !== '0.00' && (
              <p className="small dim" style={{ margin: 0 }}>
                {money(risk.withdrawableCollateral)} of collateral could be released today.
              </p>
            )}
          </div>
        </Card>

        <Card title="How your limit is built" action={<Link className="btn btn-sm" to="/assistant">Ask why</Link>}>
          {credit.decision ? (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {credit.decision.explanations.map((line, i) => (
                <li key={i} className="small muted" style={{ marginBottom: 8 }}>{line}</li>
              ))}
            </ul>
          ) : (
            <p className="muted small">No credit decision has been recorded yet.</p>
          )}
        </Card>
      </div>

      <div className="grid grid-2">
        <Card title="Allocation">
          <table>
            <thead>
              <tr>
                <th>Asset class</th>
                <th className="num">Market value</th>
                <th className="num">Eligible</th>
                <th className="num">Share</th>
              </tr>
            </thead>
            <tbody>
              {wealth.allocation.map((a) => (
                <tr key={a.assetClass}>
                  <td>{a.assetClass.replace('_', ' ')}</td>
                  <td className="num money">{money(a.marketValue)}</td>
                  <td className="num money">{money(a.eligibleValue)}</td>
                  <td className="num money">{percent(a.share)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card title="Recent alerts" action={<Link className="btn btn-sm" to="/alerts">All alerts</Link>}>
          {alerts.length === 0
            ? <p className="muted small">Nothing needs your attention.</p>
            : alerts.slice(0, 4).map((a) => (
              <div key={a.id} className={`alert${a.severity === 'critical' ? ' alert-critical' : a.severity === 'warning' ? ' alert-warning' : ''}`}>
                <span className="alert-icon" aria-hidden="true">
                  {a.severity === 'critical' ? '⚠' : a.severity === 'warning' ? '◷' : 'ⓘ'}
                </span>
                <div>
                  <div className="alert-title">{a.title}</div>
                  <div className="alert-body">{a.body}</div>
                </div>
              </div>
            ))}
        </Card>
      </div>
    </>
  );
};
