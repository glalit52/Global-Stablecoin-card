import { useEffect, useState } from 'react';
import { api, ApiError, dateTime } from '../../lib/api';
import { Card, Empty, ErrorText, Spinner } from '../../components/ui';
import { PageHead } from '../../components/Layout';

interface Approval {
  id: string; action: string; entityType: string; entityId: string;
  payload: Record<string, unknown>; justification: string;
  requestedBy: string; requestedAt: string;
}

export const Approvals = () => {
  const [items, setItems] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = async () => {
    setLoading(true);
    const res = await api.get<{ approvals: Approval[] }>('/v1/admin/approvals');
    setItems(res.approvals);
    setLoading(false);
  };

  useEffect(() => { void load(); }, []);

  const decide = async (id: string, decision: 'approve' | 'reject') => {
    setBusy(id); setError(''); setNotice('');
    try {
      const body = decision === 'reject'
        ? { reason: 'Rejected from the operations console after review.' }
        : {};
      const res = await api.post<{ result?: unknown }>(`/v1/admin/approvals/${id}/${decision}`, body);
      await load();
      setNotice(decision === 'approve'
        ? `Approved and executed. ${JSON.stringify(res.result ?? {})}`
        : 'Request rejected.');
    } catch (err) {
      // The most common failure here is the four-eyes rule, and that message
      // is exactly what the operator needs to see.
      setError(err instanceof ApiError ? err.message : 'Could not record the decision');
    } finally { setBusy(null); }
  };

  if (loading) return <Spinner />;

  return (
    <>
      <PageHead
        title="Approvals"
        sub="High-impact actions need a second operator. You cannot approve your own request."
      />

      {notice && <p className="success-text mb" role="status">{notice}</p>}
      <ErrorText>{error}</ErrorText>

      {items.length === 0 ? (
        <Card><Empty>Nothing is waiting for approval.</Empty></Card>
      ) : (
        <div className="stack">
          {items.map((a) => (
            <Card key={a.id}>
              <div className="between mb">
                <div>
                  <strong>{a.action.replace(/[._]/g, ' ')}</strong>
                  <div className="dim small">
                    {a.entityType} {a.entityId.slice(0, 8)} · requested by {a.requestedBy} · {dateTime(a.requestedAt)}
                  </div>
                </div>
                <span className="pill pill-bad">pending</span>
              </div>

              <p className="muted small">{a.justification}</p>

              {Object.keys(a.payload).length > 0 && (
                <pre className="mono" style={{
                  background: 'var(--bg-sunken)', padding: 12, borderRadius: 9,
                  overflow: 'auto', margin: '10px 0',
                }}>{JSON.stringify(a.payload, null, 2)}</pre>
              )}

              <div className="row mt">
                <button className="btn btn-primary" disabled={busy === a.id}
                  onClick={() => void decide(a.id, 'approve')}>
                  Approve and execute
                </button>
                <button className="btn btn-danger" disabled={busy === a.id}
                  onClick={() => void decide(a.id, 'reject')}>
                  Reject
                </button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
};
