import { useEffect, useState } from 'react';
import { api, money, points as fmtPoints, dateTime } from '../lib/api';
import type { RewardsView } from '../lib/types';
import { Card, Empty, Spinner, Stat } from '../components/ui';
import { PageHead } from '../components/Layout';

const CATEGORY_LABEL: Record<string, string> = {
  groceries: 'Groceries', fuel_ev: 'Fuel & EV charging', dining: 'Dining',
  travel: 'Travel', hotels: 'Hotels', lounges: 'Lounges',
};

export const Rewards = () => {
  const [data, setData] = useState<RewardsView | null>(null);

  useEffect(() => {
    void (async () => setData(await api.get<RewardsView>('/v1/rewards')))();
  }, []);

  if (!data) return <Spinner />;

  const { points, tier, economics, recent } = data;
  const progress = Math.round(Number(tier.progressToNextTier) * 100);

  return (
    <>
      <PageHead title="Rewards" sub={`${tier.current.replace('_', ' ')} membership`} />

      <div className="grid grid-4 mb">
        <Card><Stat label="Points" value={fmtPoints(points.posted)} size="sm"
          note={points.pending !== '0' ? `${fmtPoints(points.pending)} pending` : undefined} /></Card>
        <Card><Stat label="As statement credit" value={money(points.statementCreditValue)} size="sm" /></Card>
        <Card><Stat label="As travel" value={money(points.travelValue)} size="sm" note="1.5¢ per point" /></Card>
        <Card><Stat label="Earned all time" value={fmtPoints(points.lifetimeEarned)} size="sm" /></Card>
      </div>

      <div className="grid grid-2 mb">
        <Card title="How you earn">
          <table>
            <tbody>
              <tr>
                <td>Everything else</td>
                <td className="num"><strong>{tier.baseEarnRate}×</strong></td>
              </tr>
              {Object.entries(tier.categoryMultipliers).map(([category, rate]) => (
                <tr key={category}>
                  <td>{CATEGORY_LABEL[category] ?? category}</td>
                  <td className="num"><strong>{rate}×</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
          {tier.bonusCategoryMonthlyCap && (
            <p className="hint">
              Bonus rates apply to the first {money(tier.bonusCategoryMonthlyCap)} of category spend
              each month. Spend above that earns the base rate. The cap is what keeps the programme
              affordable, and it is the reason these rates can be this high at all.
            </p>
          )}
        </Card>

        <Card title="Your membership">
          <table>
            <tbody>
              <tr><td className="muted">Annual fee</td><td className="num money">{money(tier.annualFee)}</td></tr>
              <tr><td className="muted">Foreign transaction fee</td>
                <td className="num">{tier.fxMarkupBps === 0 ? 'None' : `${(tier.fxMarkupBps / 100).toFixed(2)}%`}</td></tr>
              <tr><td className="muted">Airport lounges</td>
                <td className="num">{tier.loungeUnlimited ? 'Unlimited' : `${tier.loungeVisitsRemaining ?? 0} left this year`}</td></tr>
              <tr><td className="muted">Concierge</td>
                <td className="num">{tier.conciergeIncluded ? 'Included' : '—'}</td></tr>
            </tbody>
          </table>

          {tier.nextTier && (
            <div className="mt">
              <div className="between small muted" style={{ marginBottom: 6 }}>
                <span>Progress to {tier.nextTier.replace('_', ' ')}</span>
                <span>{progress}%</span>
              </div>
              <div className="meter">
                <div className="meter-fill" style={{ width: `${progress}%`, background: 'var(--accent)' }} />
              </div>
              <p className="hint">
                {money(tier.collateralToNextTier)} more eligible collateral, or{' '}
                {money(tier.spendToNextTier)} more annual spend.
              </p>
            </div>
          )}
        </Card>
      </div>

      <div className="grid grid-2">
        <Card title="Recent earning">
          {recent.length === 0 ? <Empty>No rewards activity yet.</Empty> : (
            <table>
              <thead><tr><th>Description</th><th className="num">Points</th><th className="num">When</th></tr></thead>
              <tbody>
                {recent.map((e) => (
                  <tr key={e.id}>
                    <td className="small">{e.description || e.type.replace('_', ' ')}</td>
                    <td className="num money">
                      {e.type === 'redemption' || e.type === 'reversal' ? '−' : '+'}{fmtPoints(e.points)}
                    </td>
                    <td className="num dim small">{dateTime(e.occurredAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Programme economics">
          <p className="muted small" style={{ marginTop: 0 }}>
            We show this because a rewards programme that costs more than it earns gets withdrawn,
            and you deserve to know the one you are in is sustainable.
          </p>
          <table>
            <tbody>
              <tr><td className="muted">Your spend, trailing year</td>
                <td className="num money">{money(economics.trailingAnnualSpend)}</td></tr>
              <tr><td className="muted">Rewards accrued to you</td>
                <td className="num money">{money(economics.rewardsCost)}</td></tr>
              <tr><td className="muted">As a share of spend</td>
                <td className="num money">{economics.rewardsCostPercentOfSpend}%</td></tr>
            </tbody>
          </table>
        </Card>
      </div>
    </>
  );
};
