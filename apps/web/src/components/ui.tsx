/** Shared presentational pieces. */
import type { ReactNode } from 'react';
import type { RiskState } from '../lib/types';

export const Card = ({ title, children, action }: {
  title?: string; children: ReactNode; action?: ReactNode;
}) => (
  <section className="card">
    {(title || action) && (
      <div className="between" style={{ marginBottom: 14 }}>
        {title && <h2 className="card-title" style={{ margin: 0 }}>{title}</h2>}
        {action}
      </div>
    )}
    {children}
  </section>
);

export const Stat = ({ label, value, note, size = 'lg' }: {
  label: string; value: ReactNode; note?: ReactNode; size?: 'lg' | 'sm';
}) => (
  <div>
    <div className="stat-label">{label}</div>
    <div className={`stat-value${size === 'sm' ? ' sm' : ''}`}>{value}</div>
    {note && <div className="stat-note">{note}</div>}
  </div>
);

const STATE_COPY: Record<RiskState, string> = {
  healthy: 'Healthy',
  watch: 'Watch',
  restricted: 'Restricted',
  remediation: 'Action required',
  liquidation: 'Liquidation',
};

/**
 * Risk state badge. Carries a word as well as a colour — a state that reads
 * only as a colour is a state a colour-blind customer cannot act on.
 */
export const StateBadge = ({ state }: { state: RiskState | null }) => {
  if (!state) return <span className="pill">Not yet assessed</span>;
  return <span className={`state state-${state}`}>{STATE_COPY[state]}</span>;
};

export const stateColor = (state: RiskState | null): string => {
  switch (state) {
    case 'healthy': return 'var(--healthy)';
    case 'watch': return 'var(--watch)';
    case 'restricted': return 'var(--restricted)';
    case 'remediation': return 'var(--remediation)';
    case 'liquidation': return 'var(--liquidation)';
    default: return 'var(--text-dim)';
  }
};

export const HealthMeter = ({ percent, state }: { percent: string; state: RiskState }) => {
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  return (
    <div>
      <div className="meter">
        <div
          className="meter-fill"
          style={{ width: `${value}%`, background: stateColor(state) }}
          role="meter"
          aria-valuenow={value}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Portfolio health"
        />
      </div>
    </div>
  );
};

/**
 * The LTV ladder, drawn as the five states with the current one marked.
 * Showing the whole ladder is the point: PRD §17.3 asks for a visible risk
 * state, and a customer who can see where the next line sits can act before
 * they reach it.
 */
export const RiskLadder = ({ state, thresholds }: {
  state: RiskState;
  thresholds: { watch: string; restricted: string; remediation: string; liquidation: string };
}) => {
  const order: RiskState[] = ['healthy', 'watch', 'restricted', 'remediation', 'liquidation'];
  const index = order.indexOf(state);
  return (
    <div style={{ color: stateColor(state) }}>
      <div className="ladder">
        {order.map((s, i) => (
          <div key={s} className={`ladder-step${i <= index ? ' reached' : ''}`} />
        ))}
      </div>
      <div className="ladder-labels">
        <span>Healthy</span>
        <span>{thresholds.watch}%</span>
        <span>{thresholds.restricted}%</span>
        <span>{thresholds.remediation}%</span>
        <span>{thresholds.liquidation}%</span>
      </div>
    </div>
  );
};

export const Spinner = () => (
  <div className="center"><div className="spinner" aria-label="Loading" /></div>
);

export const Empty = ({ children }: { children: ReactNode }) => (
  <p className="muted small" style={{ padding: '18px 0', margin: 0 }}>{children}</p>
);

export const ErrorText = ({ children }: { children: ReactNode }) =>
  children ? <p className="error-text" role="alert">{children}</p> : null;

export const Banner = ({ icon, title, children, action }: {
  icon: string; title: string; children: ReactNode; action?: ReactNode;
}) => (
  <div className="banner" role="alert">
    <span className="alert-icon" aria-hidden="true">{icon}</span>
    <div style={{ flex: 1 }}>
      <div className="alert-title">{title}</div>
      <div className="alert-body">{children}</div>
      {action && <div style={{ marginTop: 11 }}>{action}</div>}
    </div>
  </div>
);
