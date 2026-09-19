import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api, getRole, getToken } from './lib/api';
import type { AlertView } from './lib/types';
import { Layout } from './components/Layout';
import { Login } from './pages/Login';
import { Overview } from './pages/Overview';
import { Wealth } from './pages/Wealth';
import { CardPage } from './pages/CardPage';
import { Activity } from './pages/Activity';
import { Rewards } from './pages/Rewards';
import { Risk } from './pages/Risk';
import { Assistant } from './pages/Assistant';
import { Alerts } from './pages/Alerts';
import { Portfolio } from './pages/ops/Portfolio';
import { Customers } from './pages/ops/Customers';
import { Liquidations } from './pages/ops/Liquidations';
import { Approvals } from './pages/ops/Approvals';
import { Ledger } from './pages/ops/Ledger';
import { Policy } from './pages/ops/Policy';
import { Audit } from './pages/ops/Audit';

const RequireAuth = ({ role, children }: { role: 'customer' | 'operator'; children: JSX.Element }) => {
  const location = useLocation();
  if (!getToken()) return <Navigate to="/login" replace state={{ from: location }} />;
  const actual = getRole();
  if (actual !== role) return <Navigate to={actual === 'operator' ? '/ops' : '/'} replace />;
  return children;
};

const CustomerShell = ({ children }: { children: JSX.Element }) => {
  const [openAlerts, setOpenAlerts] = useState(0);
  const location = useLocation();

  useEffect(() => {
    void (async () => {
      try {
        const res = await api.get<{ alerts: AlertView[] }>('/v1/alerts?status=open');
        setOpenAlerts(res.alerts.length);
      } catch {
        // A failed badge fetch must not take the page down with it.
        setOpenAlerts(0);
      }
    })();
  }, [location.pathname]);

  return <Layout alertCount={openAlerts}>{children}</Layout>;
};

export const App = () => (
  <Routes>
    <Route path="/login" element={<Login />} />

    {([
      ['/', <Overview key="o" />],
      ['/wealth', <Wealth key="w" />],
      ['/card', <CardPage key="c" />],
      ['/activity', <Activity key="a" />],
      ['/rewards', <Rewards key="r" />],
      ['/risk', <Risk key="rk" />],
      ['/assistant', <Assistant key="as" />],
      ['/alerts', <Alerts key="al" />],
    ] as const).map(([path, element]) => (
      <Route
        key={path}
        path={path}
        element={<RequireAuth role="customer"><CustomerShell>{element}</CustomerShell></RequireAuth>}
      />
    ))}

    {([
      ['/ops', <Portfolio key="p" />],
      ['/ops/customers', <Customers key="c" />],
      ['/ops/liquidations', <Liquidations key="l" />],
      ['/ops/approvals', <Approvals key="ap" />],
      ['/ops/ledger', <Ledger key="ld" />],
      ['/ops/policy', <Policy key="po" />],
      ['/ops/audit', <Audit key="au" />],
    ] as const).map(([path, element]) => (
      <Route
        key={path}
        path={path}
        element={<RequireAuth role="operator"><Layout>{element}</Layout></RequireAuth>}
      />
    ))}

    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes>
);
