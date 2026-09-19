import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, setSession, ApiError } from '../lib/api';

export const Login = () => {
  const navigate = useNavigate();
  const [mode, setMode] = useState<'customer' | 'operator'>('customer');
  const [email, setEmail] = useState('ana@example.com');
  const [password, setPassword] = useState('wealth-demo-2026!');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const path = mode === 'operator' ? '/v1/operator/login' : '/v1/auth/login';
      const res = await api.post<{ token: string }>(path, { email, password });
      setSession(res.token, mode);
      navigate(mode === 'operator' ? '/ops' : '/');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in');
    } finally {
      setBusy(false);
    }
  };

  const switchMode = (next: 'customer' | 'operator') => {
    setMode(next);
    setEmail(next === 'operator' ? 'risk@wealthcard.example' : 'ana@example.com');
    setPassword('wealth-demo-2026!');
    setError('');
  };

  return (
    <div className="center">
      <div style={{ width: 380, maxWidth: '92vw' }}>
        <div className="row" style={{ marginBottom: 26, justifyContent: 'center' }}>
          <div className="brand-mark" style={{ width: 40, height: 40, fontSize: 22 }} aria-hidden="true">W</div>
          <div>
            <div style={{ fontFamily: 'var(--serif)', fontSize: 23 }}>Global Wealth Card</div>
            <div className="dim small">Spend without selling your wealth</div>
          </div>
        </div>

        <div className="card">
          <div className="row" style={{ marginBottom: 20, gap: 8 }}>
            {(['customer', 'operator'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => switchMode(m)}
                className={`btn btn-sm${mode === m ? ' btn-primary' : ''}`}
                style={{ flex: 1 }}
              >
                {m === 'customer' ? 'Customer' : 'Operations'}
              </button>
            ))}
          </div>

          <form onSubmit={submit}>
            <div className="field">
              <label htmlFor="email">Email</label>
              <input
                id="email" className="input" type="email" value={email} autoComplete="username"
                onChange={(e) => setEmail(e.target.value)} required
              />
            </div>
            <div className="field">
              <label htmlFor="password">Password</label>
              <input
                id="password" className="input" type="password" value={password}
                autoComplete="current-password"
                onChange={(e) => setPassword(e.target.value)} required
              />
            </div>
            {error && <p className="error-text" role="alert">{error}</p>}
            <button className="btn btn-primary" style={{ width: '100%' }} disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <p className="hint" style={{ marginTop: 16 }}>
            Demo accounts are pre-filled. Customers: ana@, devi@, marcus@example.com.
            Operations: risk@, compliance@, admin@wealthcard.example.
          </p>
        </div>
      </div>
    </div>
  );
};
