import { FormEvent, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Account, CURRENCIES, Currency, Receipt, api, idemKey } from '../api';
import { useMe } from '../App';
import { Alert, CurrencyPicker, Page, money, normalizeAmount, useAction, useLoad, usePin } from '../ui';

/** Enviar dinero a otro usuario por su correo. Confirmación con PIN. */
export default function Send() {
  const { me } = useMe();
  const askPin = usePin();
  const accounts = useLoad(() => api<Account[]>('GET', '/wallet/accounts'));
  const [currency, setCurrency] = useState<Currency>('USD');
  const [toEmail, setToEmail] = useState('');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [done, setDone] = useState<Receipt | null>(null);
  // La misma clave para los reintentos de este envío: si se pierde la respuesta, no se duplica.
  const key = useMemo(() => idemKey(), [done]); // eslint-disable-line react-hooks/exhaustive-deps

  const balance = accounts.data?.find((a) => a.currency === currency)?.balance ?? '0.00';
  const action = useAction(async () => {
    const value = normalizeAmount(amount);
    if (!value) throw new Error('Ingresa un monto válido');
    if (Number(value) > Number(balance)) throw new Error('No tienes saldo suficiente');
    const pin = await askPin('Confirmar envío', `${money(value, currency)} a ${toEmail}`);
    if (!pin) return;
    const r = await api<Receipt>(
      'POST',
      '/wallet/transfers',
      { toEmail, currency, amount: value, description: description || undefined, pin },
      { headers: { 'Idempotency-Key': key } },
    );
    setDone(r);
    accounts.reload();
  });

  if (!me?.hasPin) {
    return (
      <Page title="Enviar dinero" back>
        <Alert kind="info">Para enviar dinero primero configura tu PIN de pagos.</Alert>
        <Link to="/perfil" className="btn primary">
          Configurar PIN
        </Link>
      </Page>
    );
  }

  if (done) {
    const mv = done.movements[0];
    return (
      <Page title="Enviar dinero" back>
        <div className="card center success">
          <div className="check">✓</div>
          <h2>¡Enviado!</h2>
          <p className="big">{money(mv.amount.replace('-', ''), mv.currency)}</p>
          <p>a {done.counterparty}</p>
          <p className="muted small">Nuevo saldo: {money(mv.balanceAfter, mv.currency)}</p>
          <button
            className="btn ghost"
            onClick={() => {
              setDone(null);
              setAmount('');
              setDescription('');
            }}
          >
            Hacer otro envío
          </button>
        </div>
      </Page>
    );
  }

  return (
    <Page title="Enviar dinero" back>
      <form
        className="card"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void action.run();
        }}
      >
        <Alert>{action.error}</Alert>
        <label>
          Correo del destinatario
          <input type="email" value={toEmail} onChange={(e) => setToEmail(e.target.value)} required placeholder="amigo@correo.com" />
        </label>
        <span className="label">Moneda</span>
        <CurrencyPicker value={currency} onChange={setCurrency} options={CURRENCIES} />
        <label>
          Monto
          <input className="amount-input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0,00" required />
          <small className="muted">Disponible: {money(balance, currency)}</small>
        </label>
        <label>
          Mensaje (opcional)
          <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={140} placeholder="Pizza del viernes" />
        </label>
        <button className="btn primary" disabled={action.busy}>
          {action.busy ? 'Enviando…' : 'Continuar'}
        </button>
      </form>
    </Page>
  );
}
