import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { Card, Spinner } from '../../components/ui';
import { PageHead } from '../../components/Layout';

interface PolicyView {
  activeVersion: string;
  available: { version: string; valid: boolean; validationErrors: string[] }[];
  active: {
    version: string; description: string; effectiveFrom: string;
    thresholds: Record<string, string | number>;
    assets: Record<string, Record<string, string | number | boolean>>;
    tiers: Record<string, Record<string, unknown>>;
    stablecoins: { whitelist: string[]; depegThreshold: string; issuerConcentrationCap: string };
    credit: Record<string, string | number | null>;
    stressScenarios: { id: string; label: string }[];
  };
  history: { policy_version: string; activated_at: string; activated_by: string | null; notes: string }[];
}

const pct = (v: unknown) => `${(Number(v) * 100).toFixed(1)}%`;

export const Policy = () => {
  const [policy, setPolicy] = useState<PolicyView | null>(null);

  useEffect(() => {
    void (async () => setPolicy(await api.get<PolicyView>('/v1/admin/policies')))();
  }, []);

  if (!policy) return <Spinner />;
  const p = policy.active;

  return (
    <>
      <PageHead
        title="Risk policy"
        sub={`${p.version} · ${p.description}`}
        action={
          <span className={`pill${policy.available.every((a) => a.valid) ? ' pill-ok' : ' pill-bad'}`}>
            {policy.available.every((a) => a.valid) ? 'All versions valid' : 'Validation errors'}
          </span>
        }
      />

      <Card title="Why this page exists">
        <p className="muted small" style={{ margin: 0 }}>
          Every threshold, haircut and cap the platform applies is read from a versioned policy, and
          every credit and risk decision is stamped with the version that produced it. Nothing here
          is hard-coded in an engine, which is what makes a past decision reproducible: replay the
          inputs against the version it carries and you get the same answer. Changing the active
          version is a dual-approved action.
        </p>
      </Card>

      <div className="grid grid-2 mt mb">
        <Card title="LTV ladder">
          <table>
            <tbody>
              <tr><td className="muted">Advance rate at origination</td><td className="num money">{pct(p.thresholds.maxOriginationLtv)}</td></tr>
              <tr><td><span className="state state-watch">Watch</span></td><td className="num money">{pct(p.thresholds.watchLtv)}</td></tr>
              <tr><td><span className="state state-restricted">Restricted</span></td><td className="num money">{pct(p.thresholds.restrictedLtv)}</td></tr>
              <tr><td><span className="state state-remediation">Remediation</span></td><td className="num money">{pct(p.thresholds.remediationLtv)}</td></tr>
              <tr><td><span className="state state-liquidation">Liquidation</span></td><td className="num money">{pct(p.thresholds.liquidationLtv)}</td></tr>
              <tr><td className="muted">Restores to</td><td className="num money">{pct(p.thresholds.liquidationTargetLtv)}</td></tr>
              <tr><td className="muted">Cure window</td><td className="num money">{String(p.thresholds.remediationWindowHours)} hours</td></tr>
              <tr><td className="muted">Spend blocked above</td><td className="num money">{pct(p.thresholds.spendBlockLtv)}</td></tr>
            </tbody>
          </table>
        </Card>

        <Card title="Credit engine">
          <table>
            <tbody>
              <tr><td className="muted">Baseline stress scenario</td><td className="num small">{String(p.credit.baselineStressScenarioId)}</td></tr>
              <tr><td className="muted">Expected survival under it</td><td className="num money">{pct(p.credit.expectedStressSurvival)}</td></tr>
              <tr><td className="muted">Adequate book liquidity</td><td className="num money">{pct(p.credit.adequateLiquidity)}</td></tr>
              <tr><td className="muted">Base APR</td><td className="num money">{(Number(p.credit.baseAprBps) / 100).toFixed(2)}%</td></tr>
              <tr><td className="muted">Grace period</td><td className="num money">{String(p.credit.gracePeriodDays)} days</td></tr>
              <tr><td className="muted">Minimum payment</td><td className="num money">{pct(p.credit.minimumPaymentRate)} or {String(p.credit.minimumPaymentFloor)}</td></tr>
            </tbody>
          </table>
        </Card>
      </div>

      <Card title="Asset policy">
        <table>
          <thead>
            <tr>
              <th>Asset class</th><th className="num">Eligible</th><th className="num">Base haircut</th>
              <th className="num">Max haircut</th><th className="num">Concentration cap</th>
              <th className="num">Price max age</th><th className="num">Sale priority</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(p.assets).map(([cls, a]) => (
              <tr key={cls} style={{ opacity: a.eligibleForCollateral ? 1 : 0.5 }}>
                <td>
                  <strong>{cls}</strong>
                  {!a.eligibleForCollateral && <div className="dim small">not enabled</div>}
                </td>
                <td className="num money">{pct(a.eligibilityFactor)}</td>
                <td className="num money">{pct(a.baseHaircut)}</td>
                <td className="num money">{pct(a.maxHaircut)}</td>
                <td className="num money">{pct(a.concentrationCap)}</td>
                <td className="num money">{String(a.maxPriceAgeSeconds)}s</td>
                <td className="num money">{String(a.liquidationPriority)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <div className="grid grid-2 mt">
        <Card title="Stablecoins">
          <table>
            <tbody>
              <tr><td className="muted">Whitelist</td><td className="num">{p.stablecoins.whitelist.join(', ')}</td></tr>
              <tr><td className="muted">Depeg threshold</td><td className="num money">{pct(p.stablecoins.depegThreshold)}</td></tr>
              <tr><td className="muted">Issuer concentration cap</td><td className="num money">{pct(p.stablecoins.issuerConcentrationCap)}</td></tr>
            </tbody>
          </table>
        </Card>

        <Card title="Stress scenarios">
          <table>
            <tbody>
              {p.stressScenarios.map((s) => (
                <tr key={s.id}>
                  <td className="mono small">{s.id}</td>
                  <td className="muted small">{s.label}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
    </>
  );
};
