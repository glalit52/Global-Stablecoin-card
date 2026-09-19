import { Fragment, useEffect, useState } from 'react';
import { api, dateTime } from '../../lib/api';
import { Card, Empty, Spinner } from '../../components/ui';
import { PageHead } from '../../components/Layout';

interface AuditEntry {
  id: string; actor_type: string; actor_id: string; action: string;
  entity_type: string; entity_id: string;
  before_state: unknown; after_state: unknown;
  policy_version: string | null; occurred_at: string;
}

export const Audit = () => {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [action, setAction] = useState('');
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    const params = new URLSearchParams({ limit: '200' });
    if (action) params.set('action', action);
    const res = await api.get<{ entries: AuditEntry[] }>(`/v1/admin/audit?${params}`);
    setEntries(res.entries);
    setLoading(false);
  };

  useEffect(() => { void load(); }, []);

  return (
    <>
      <PageHead
        title="Audit log"
        sub="Every material action, append-only, with the policy version in force at the time"
      />

      <Card>
        <form className="row mb" onSubmit={(e) => { e.preventDefault(); void load(); }}>
          <input
            className="input" placeholder="Filter by action, e.g. credit.limit_changed"
            value={action} onChange={(e) => setAction(e.target.value)}
          />
          <button className="btn">Filter</button>
        </form>

        {loading ? <Spinner /> : entries.length === 0 ? <Empty>No audit entries match.</Empty> : (
          <table>
            <thead>
              <tr><th>Action</th><th>Actor</th><th>Entity</th><th>Policy</th><th className="num">When</th></tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <Fragment key={e.id}>
                  <tr onClick={() => setExpanded(expanded === e.id ? null : e.id)}
                    style={{ cursor: 'pointer' }}>
                    <td><strong className="small">{e.action}</strong></td>
                    <td className="small">
                      <span className="pill">{e.actor_type}</span>
                      <div className="dim small" style={{ marginTop: 3 }}>{e.actor_id.slice(0, 18)}</div>
                    </td>
                    <td className="small muted">{e.entity_type} {e.entity_id.slice(0, 8)}</td>
                    <td className="dim small">{e.policy_version ?? '—'}</td>
                    <td className="num dim small">{dateTime(e.occurred_at)}</td>
                  </tr>
                  {expanded === e.id && (
                    <tr>
                      <td colSpan={5} style={{ background: 'var(--bg-sunken)' }}>
                        <div className="grid grid-2">
                          <div>
                            <div className="stat-label">Before</div>
                            <pre className="mono" style={{ margin: 0, overflow: 'auto' }}>
                              {JSON.stringify(e.before_state, null, 2) ?? 'null'}
                            </pre>
                          </div>
                          <div>
                            <div className="stat-label">After</div>
                            <pre className="mono" style={{ margin: 0, overflow: 'auto' }}>
                              {JSON.stringify(e.after_state, null, 2) ?? 'null'}
                            </pre>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
};
