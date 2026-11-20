import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, logout } from '../api';
import { useMe } from '../App';
import { Alert, Page, Sheet, useAction, useLoad } from '../ui';

const KYC_TEXT = { NOT_STARTED: 'Sin verificar', PENDING: 'En revisión', APPROVED: 'Verificada', REJECTED: 'Rechazada' };

export default function Profile() {
  const { me, refreshMe } = useMe();
  const [pinOpen, setPinOpen] = useState(false);
  // Solo las cuentas que reciben cobros de un POS (asignadas por el admin) ven "Mi comercio".
  const merchant = useLoad(() => api<{ name: string }>('GET', '/payments/merchants/me').catch(() => null));
  if (!me) return null;

  return (
    <Page title="Perfil">
      <div className="card profile">
        <div className="avatar big">{me.fullName[0]}</div>
        <div>
          <h2>{me.fullName}</h2>
          <p className="muted">{me.email}</p>
        </div>
      </div>

      <ul className="menu card">
        <li>
          <Link to="/verificar">
            <span>🪪 Identidad</span>
            <span className={`badge ${me.kycStatus}`}>{KYC_TEXT[me.kycStatus]}</span>
          </Link>
        </li>
        <li>
          <button type="button" onClick={() => setPinOpen(true)}>
            <span>🔒 PIN de pagos</span>
            <span className={`badge ${me.hasPin ? 'APPROVED' : 'PENDING'}`}>{me.hasPin ? 'Configurado' : 'Configurar'}</span>
          </button>
        </li>
        <li>
          <Link to="/tarjeta">
            <span>💳 Tarjeta virtual</span>
            <span className="muted">›</span>
          </Link>
        </li>
        {merchant.data && (
          <li>
            <Link to="/comercio">
              <span>🏪 Cobros de {merchant.data.name}</span>
              <span className="muted">›</span>
            </Link>
          </li>
        )}
        {me.role === 'ADMIN' && (
          <li>
            <a href="/admin">
              <span>🛠 Panel de administración</span>
              <span className="muted">›</span>
            </a>
          </li>
        )}
      </ul>

      <button className="btn ghost danger" onClick={() => void logout()}>
        Cerrar sesión
      </button>
      <p className="muted small center">Billetera · simulación académica. Ningún dinero es real.</p>

      {pinOpen && (
        <PinSheet
          hasPin={me.hasPin}
          onClose={() => setPinOpen(false)}
          onDone={async () => {
            await refreshMe();
            setPinOpen(false);
          }}
        />
      )}
    </Page>
  );
}

function PinSheet({ hasPin, onClose, onDone }: { hasPin: boolean; onClose: () => void; onDone: () => Promise<void> }) {
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [password, setPassword] = useState('');
  const save = useAction(async () => {
    if (pin !== pin2) throw new Error('Los PIN no coinciden');
    await api('POST', '/auth/pin', { pin, password });
    await onDone();
  });
  return (
    <Sheet title={hasPin ? 'Cambiar PIN de pagos' : 'Crear PIN de pagos'} onClose={onClose}>
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void save.run();
        }}
      >
        <p className="muted small">De 4 a 6 dígitos. Evita secuencias como 1234 o 1111.</p>
        <Alert>{save.error}</Alert>
        <label>
          Nuevo PIN
          <input className="pin" type="password" inputMode="numeric" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} required />
        </label>
        <label>
          Repetir PIN
          <input className="pin" type="password" inputMode="numeric" maxLength={6} value={pin2} onChange={(e) => setPin2(e.target.value.replace(/\D/g, ''))} required />
        </label>
        <label>
          Contraseña de tu cuenta
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        <button className="btn primary" disabled={save.busy || pin.length < 4}>
          Guardar PIN
        </button>
      </form>
    </Sheet>
  );
}
