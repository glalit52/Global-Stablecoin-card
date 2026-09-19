import { useEffect, useState } from 'react';
import { api, money, percent, dateOnly } from '../../lib/api';
import type { AdminCustomer } from '../../lib/types';
import { Card, Empty, Spinner, StateBadge } from '../../components/ui';
import { PageHead } from '../../components/Layout';

export const Customers = () => {
  const [customers, setCustomers] = useState<AdminCustomer[]>([]);
  const [search, setSearch] = useState('');
  const [state, setState] = useState('');
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Record<string, unknown> | null>(null);

  const load = async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (state) params.set('state', state);
    const res = await api.get<{ customers: AdminCustomer[] }>(`/v1/admin/customers?${params}`);
    setCustomers(res.customers);
    setLoading(false);
  };

  useEffect(() => { void load(); }, [state]);

  const open = async (id: string) => {
    setSelected(await api.get<Record<string, unknown>>(`/v1/admin/customers/${id}`));
  };

  const refresh = async (id: string) => {
    await api.post(`/v1/admin/customers/${id}/refresh`);
    await load();
    await open(id);
  };

  if (selected) {
    const c = selected.customer as Record<string, string>;
    const facility = selected.facility as Record<string, string> | null;
    const risk = selected.risk as Record<string, string> | null;
    const collateral = selected.collateral as { eligibleValue: string; marketValue: string; positions: Record<string, string | boolean>[] };
    const stress = selected.stress as { scenarios: { id: string; label: string; state: string; survives: boolean; collateralShortfall: string }[] } | null;

    return (
      <>
        <PageHead
          title={c.legalName!}
          sub={`${c.email} · ${c.jurisdiction} · ${c.tier}`}
          action={
            <div className="row">
              <button className="btn btn-sm" onClick={() => void refresh(c.id!)}>Revalue</button>
              <button className="btn btn-sm" onClick={() => setSelected(null)}>Back</button>
            </div>
          }
        />

        <div className="grid grid-4 mb">
          <Card>
            <div className="stat-label">Risk state</div>
            <div style={{ marginTop: 6 }}>
              <StateBadge state={(risk?.state as never) ?? null} />
            </div>
            {risk && <div className="stat-note">{risk.healthPercent}% health · {percent(risk.effectiveLtv)} LTV</div>}
          </Card>
          <Card>
            <div className="stat-label">Credit limit</div>
            <div className="stat-value sm">{money(facility?.creditLimit)}</div>
            <div className="stat-note">{facility?.status}</div>
          </Card>
          <Card>
            <div className="stat-label">Balance</div>
            <div className="stat-value sm">{money(facility?.principalBalance)}</div>
            <div className="stat-note">{money(facility?.holds)} pending</div>
          </Card>
          <Card>
            <div className="stat-label">Eligible collateral</div>
            <div className="stat-value sm">{money(collateral.eligibleValue)}</div>
            <div className="stat-note">of {money(collateral.marketValue)} market value</div>
          </Card>
        </div>

        <div className="grid grid-2 mb">
          <Card title="Collateral">
            <table>
              <thead><tr><th>Asset</th><th className="num">Market</th><th className="num">Haircut</th><th className="num">Eligible</th></tr></thead>
              <tbody>
                {collateral.positions.map((p, i) => (
                  <tr key={i}>
                    <td>
                      <strong>{String(p.symbol)}</strong>
                      {!p.eligible && (
                        <div className="dim small">{(p.reasons as unknown as string[])?.join(', ')}</div>
                      )}
                    </td>
                    <td className="num money">{money(String(p.marketValue))}</td>
                    <td className="num money">{p.eligible ? `${String(p.haircut)}%` : '—'}</td>
                    <td className="num money">{p.eligible ? money(String(p.eligibleValue)) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Card title="Stress">
            {stress ? (
              <table>
                <thead><tr><th>Scenario</th><th>Outcome</th><th className="num">Shortfall</th></tr></thead>
                <tbody>
                  {stress.scenarios.map((s) => (
                    <tr key={s.id}>
                      <td className="small">{s.label}</td>
                      <td><StateBadge state={s.state as never} /></td>
                      <td className="num money">{s.collateralShortfall === '0.00' ? '—' : money(s.collateralShortfall)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <Empty>No risk snapshot available.</Empty>}
          </Card>
        </div>

        <div className="grid grid-2">
          <Card title="Recent transactions">
            <table>
              <thead><tr><th>Merchant</th><th className="num">Amount</th><th>Status</th></tr></thead>
              <tbody>
                {(selected.transactions as Record<string, string>[]).map((t) => (
                  <tr key={t.id}>
                    <td>{t.merchant_name}<div className="dim small">{t.category}</div></td>
                    <td className="num money">{money(t.billing_amount)}</td>
                    <td><span className="pill">{t.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Card title="Alerts and margin calls">
            <table>
              <thead><tr><th>Event</th><th>Status</th></tr></thead>
              <tbody>
                {(selected.alerts as Record<string, string>[]).map((a) => (
                  <tr key={a.id}>
                    <td>{a.title}<div className="dim small">{a.kind} · {a.severity}</div></td>
                    <td><span className="pill">{a.status}</span></td>
                  </tr>
                ))}
                {(selected.marginCalls as Record<string, string>[]).map((m) => (
                  <tr key={m.id}>
                    <td>Margin call for {money(m.required_amount)}
                      <div className="dim small">raised {dateOnly(m.raised_at)}</div>
                    </td>
                    <td>
                      <span className={`pill${m.cured_at ? ' pill-ok' : ' pill-bad'}`}>
                        {m.cured_at ? `cured (${m.cure_method})` : 'open'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHead title="Customers" sub={`${customers.length} shown, riskiest first`} />

      <Card>
        <form className="row mb" onSubmit={(e) => { e.preventDefault(); void load(); }}>
          <input
            className="input" placeholder="Search name or email"
            value={search} onChange={(e) => setSearch(e.target.value)}
          />
          <select className="select" style={{ width: 190 }} value={state} onChange={(e) => setState(e.target.value)}>
            <option value="">All risk states</option>
            <option value="liquidation">Liquidation</option>
            <option value="remediation">Action required</option>
            <option value="restricted">Restricted</option>
            <option value="watch">Watch</option>
            <option value="healthy">Healthy</option>
          </select>
          <button className="btn">Search</button>
        </form>

        {loading ? <Spinner /> : customers.length === 0 ? <Empty>No customers match.</Empty> : (
          <table>
            <thead>
              <tr>
                <th>Customer</th><th>Tier</th><th>Risk</th>
                <th className="num">Limit</th><th className="num">Balance</th>
                <th className="num">LTV</th><th />
              </tr>
            </thead>
            <tbody>
              {customers.map((c) => (
                <tr key={c.id}>
                  <td>
                    <strong>{c.legalName}</strong>
                    <div className="dim small">{c.email} · {c.jurisdiction}</div>
                  </td>
                  <td className="small">{c.tier.replace('_', ' ')}</td>
                  <td><StateBadge state={c.riskState} /></td>
                  <td className="num money">{money(c.creditLimit)}</td>
                  <td className="num money">{money(c.balance)}</td>
                  <td className="num money">{percent(c.effectiveLtv)}</td>
                  <td className="num">
                    <button className="btn btn-sm" onClick={() => void open(c.id)}>Open</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
};
