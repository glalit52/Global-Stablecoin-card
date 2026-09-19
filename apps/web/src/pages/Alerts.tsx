import { useEffect, useState } from 'react';
import { api, dateTime } from '../lib/api';
import type { AlertView } from '../lib/types';
import { Card, Empty, Spinner } from '../components/ui';
import { PageHead } from '../components/Layout';

export const Alerts = () => {
  const [alerts, setAlerts] = useState<AlertView[]>([]);
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const [loading, setLoading] = useState(true);

  const load = async (status: 'open' | 'all') => {
    setLoading(true);
    const res = await api.get<{ alerts: AlertView[] }>(`/v1/alerts?status=${status}`);
    setAlerts(res.alerts);
    setLoading(false);
  };

  useEffect(() => { void load(filter); }, [filter]);

  const acknowledge = async (id: string) => {
    await api.post(`/v1/alerts/${id}/acknowledge`);
    await load(filter);
  };

  return (
    <>
      <PageHead
        title="Alerts"
        sub="Risk, fraud and credit notices"
        action={
          <button className="btn btn-sm" onClick={() => setFilter(filter === 'open' ? 'all' : 'open')}>
            {filter === 'open' ? 'Show all' : 'Show open only'}
          </button>
        }
      />

      <Card>
        {loading ? <Spinner /> : alerts.length === 0 ? (
          <Empty>Nothing needs your attention.</Empty>
        ) : (
          alerts.map((a) => (
            <div
              key={a.id}
              className={`alert${a.severity === 'critical' ? ' alert-critical' : a.severity === 'warning' ? ' alert-warning' : ''}`}
            >
              <span className="alert-icon" aria-hidden="true">
                {a.severity === 'critical' ? '⚠' : a.severity === 'warning' ? '◷' : 'ⓘ'}
              </span>
              <div style={{ flex: 1 }}>
                <div className="between">
                  <div className="alert-title">{a.title}</div>
                  <span className="dim small">{dateTime(a.createdAt)}</span>
                </div>
                <div className="alert-body">{a.body}</div>
                <div className="row" style={{ marginTop: 10 }}>
                  {a.actionHref && (
                    <a className="btn btn-sm btn-primary" href={a.actionHref}>
                      {a.actionLabel ?? 'Take action'}
                    </a>
                  )}
                  {a.status === 'open' && (
                    <button className="btn btn-sm" onClick={() => void acknowledge(a.id)}>
                      Dismiss
                    </button>
                  )}
                  {a.status !== 'open' && <span className="pill">{a.status}</span>}
                </div>
              </div>
            </div>
          ))
        )}
      </Card>
    </>
  );
};
