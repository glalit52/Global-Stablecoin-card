import { NavLink, useNavigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { clearSession, getRole } from '../lib/api';

interface NavEntry { to: string; icon: string; label: string; badge?: number }

export const Layout = ({ children, alertCount = 0 }: { children: ReactNode; alertCount?: number }) => {
  const navigate = useNavigate();
  const role = getRole();

  const customerNav: NavEntry[] = [
    { to: '/', icon: '◈', label: 'Overview' },
    { to: '/wealth', icon: '◇', label: 'Wealth' },
    { to: '/card', icon: '▭', label: 'Card' },
    { to: '/activity', icon: '≡', label: 'Activity' },
    { to: '/rewards', icon: '✦', label: 'Rewards' },
    { to: '/risk', icon: '◎', label: 'Risk' },
    { to: '/assistant', icon: '✳', label: 'Assistant' },
    { to: '/alerts', icon: '⚑', label: 'Alerts', badge: alertCount },
  ];

  const operatorNav: NavEntry[] = [
    { to: '/ops', icon: '◈', label: 'Portfolio' },
    { to: '/ops/customers', icon: '◇', label: 'Customers' },
    { to: '/ops/liquidations', icon: '⚠', label: 'Liquidations' },
    { to: '/ops/approvals', icon: '✓', label: 'Approvals' },
    { to: '/ops/ledger', icon: '≡', label: 'Ledger' },
    { to: '/ops/policy', icon: '⚖', label: 'Risk policy' },
    { to: '/ops/audit', icon: '⧉', label: 'Audit log' },
  ];

  const nav = role === 'operator' ? operatorNav : customerNav;

  const signOut = () => {
    clearSession();
    navigate('/login');
  };

  return (
    <div className="app">
      <nav className="sidebar" aria-label="Main">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">W</div>
          <div>
            <div className="brand-name">Global Wealth</div>
            <div className="brand-sub">{role === 'operator' ? 'Operations' : 'Card'}</div>
          </div>
        </div>

        {nav.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/' || item.to === '/ops'}
            className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
          >
            <span className="nav-icon" aria-hidden="true">{item.icon}</span>
            <span>{item.label}</span>
            {item.badge ? <span className="nav-badge">{item.badge}</span> : null}
          </NavLink>
        ))}

        <div style={{ marginTop: 'auto' }}>
          <button className="nav-item" onClick={signOut} style={{ width: '100%', background: 'none', border: 'none', cursor: 'pointer' }}>
            <span className="nav-icon" aria-hidden="true">⤳</span>
            <span>Sign out</span>
          </button>
        </div>
      </nav>

      <main className="main">{children}</main>
    </div>
  );
};

export const PageHead = ({ title, sub, action }: { title: string; sub?: string; action?: ReactNode }) => (
  <header className="page-head">
    <div className="between">
      <div>
        <h1 className="page-title">{title}</h1>
        {sub && <p className="page-sub">{sub}</p>}
      </div>
      {action}
    </div>
  </header>
);
