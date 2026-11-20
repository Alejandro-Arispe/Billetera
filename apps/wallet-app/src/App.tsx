import { Suspense, createContext, lazy, useCallback, useContext, useEffect, useState } from 'react';
import { BrowserRouter, NavLink, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { Me, api, getSession, onSessionChange } from './api';
import Activity from './pages/Activity';
import Cards from './pages/Cards';
import Exchange from './pages/Exchange';
import Home from './pages/Home';
import Login from './pages/Login';
import Merchant from './pages/Merchant';
import Profile from './pages/Profile';
import Send from './pages/Send';
import TopUp from './pages/TopUp';
import Verify from './pages/Verify';
import { PinProvider, Spinner } from './ui';

// El lector de QR es pesado: se descarga solo al abrir "Pagar".
const Scan = lazy(() => import('./pages/Scan'));

interface AuthState {
  me: Me | null;
  refreshMe: () => Promise<void>;
}
const AuthCtx = createContext<AuthState>({ me: null, refreshMe: async () => undefined });
export const useMe = () => useContext(AuthCtx);

function AuthProvider({ children }: { children: React.ReactNode }) {
  const [signedIn, setSignedIn] = useState(!!getSession());
  const [me, setMe] = useState<Me | null>(null);

  const refreshMe = useCallback(async () => {
    if (!getSession()) return setMe(null);
    try {
      setMe(await api<Me>('GET', '/auth/me'));
    } catch {
      setMe(null);
    }
  }, []);

  useEffect(() => onSessionChange((s) => setSignedIn(!!s)), []);
  useEffect(() => {
    void refreshMe();
  }, [signedIn, refreshMe]);

  if (signedIn && !me) return <Spinner />;
  return <AuthCtx.Provider value={{ me: signedIn ? me : null, refreshMe }}>{children}</AuthCtx.Provider>;
}

function RequireAuth() {
  const { me } = useMe();
  const loc = useLocation();
  if (!me) return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />;
  return <Shell />;
}

const NAV = [
  { to: '/', label: 'Inicio', icon: '⌂', end: true },
  { to: '/actividad', label: 'Actividad', icon: '☰' },
  { to: '/pagar', label: 'Pagar', icon: '▣', main: true },
  { to: '/tarjeta', label: 'Tarjeta', icon: '▭' },
  { to: '/perfil', label: 'Perfil', icon: '◉' },
];

function Shell() {
  return (
    <div className="shell">
      <main className="content">
        <Suspense fallback={<Spinner />}>
          <Outlet />
        </Suspense>
      </main>
      <nav className="tabbar" aria-label="Principal">
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `tab${n.main ? ' main' : ''}${isActive ? ' active' : ''}`}>
            <span className="tab-icon" aria-hidden>
              {n.icon}
            </span>
            <span>{n.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <PinProvider>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route element={<RequireAuth />}>
              <Route index element={<Home />} />
              <Route path="actividad" element={<Activity />} />
              <Route path="enviar" element={<Send />} />
              <Route path="recargar" element={<TopUp />} />
              <Route path="cambiar" element={<Exchange />} />
              <Route path="pagar" element={<Scan />} />
              <Route path="tarjeta" element={<Cards />} />
              <Route path="perfil" element={<Profile />} />
              <Route path="verificar" element={<Verify />} />
              <Route path="comercio" element={<Merchant />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </PinProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
