import { Link } from 'react-router-dom';
import { Account, Movement, api } from '../api';
import { useMe } from '../App';
import { Alert, currencyName, money, useLoad } from '../ui';
import { MovementRow } from './Activity';

const ACTIONS = [
  { to: '/recargar', icon: '＋', label: 'Recargar' },
  { to: '/enviar', icon: '↗', label: 'Enviar' },
  { to: '/cambiar', icon: '⇄', label: 'Cambiar' },
  { to: '/pagar', icon: '▣', label: 'Pagar QR' },
];

export default function Home() {
  const { me } = useMe();
  const accounts = useLoad(() => api<Account[]>('GET', '/wallet/accounts'));
  const recent = useLoad(() => api<{ items: Movement[] }>('GET', '/wallet/transactions?limit=5'));
  const first = me?.fullName.split(' ')[0];

  return (
    <section className="page">
      <header className="home-head">
        <div>
          <p className="muted">Hola,</p>
          <h1>{first}</h1>
        </div>
        <Link to="/perfil" className="avatar" aria-label="Perfil">
          {first?.[0]}
        </Link>
      </header>

      {me?.kycStatus !== 'APPROVED' && (
        <Link to="/verificar" className="banner">
          <strong>{me?.kycStatus === 'PENDING' ? 'Verificación en revisión' : 'Verifica tu identidad'}</strong>
          <span>
            {me?.kycStatus === 'PENDING'
              ? 'Te avisaremos por correo cuando esté lista.'
              : 'Necesario para habilitar tu tarjeta virtual.'}
          </span>
        </Link>
      )}
      {me && !me.hasPin && (
        <Link to="/perfil" className="banner warn">
          <strong>Configura tu PIN de pagos</strong>
          <span>Lo vas a usar para confirmar envíos y pagos.</span>
        </Link>
      )}

      <Alert>{accounts.error}</Alert>
      <div className="balances">
        {(accounts.data ?? []).map((a) => (
          <article key={a.currency} className={`balance ${a.currency}`}>
            <span className="muted">
              {currencyName(a.currency)} · {a.currency}
            </span>
            <strong>{money(a.balance, a.currency)}</strong>
          </article>
        ))}
        {!accounts.data && !accounts.error && <div className="balance skeleton" />}
      </div>

      <div className="actions">
        {ACTIONS.map((a) => (
          <Link key={a.to} to={a.to} className="action">
            <span className="action-icon" aria-hidden>
              {a.icon}
            </span>
            {a.label}
          </Link>
        ))}
      </div>

      <div className="section-head">
        <h2>Últimos movimientos</h2>
        <Link to="/actividad" className="link">
          Ver todo
        </Link>
      </div>
      <Alert>{recent.error}</Alert>
      <ul className="list card">
        {recent.data?.items.length === 0 && <li className="empty">Todavía no hay movimientos. Empieza con una recarga.</li>}
        {recent.data?.items.map((m, i) => (
          <MovementRow key={`${m.transactionId}-${i}`} m={m} />
        ))}
      </ul>
    </section>
  );
}
