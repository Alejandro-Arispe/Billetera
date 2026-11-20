import { FormEvent, useState } from 'react';
import { CURRENCIES, Currency, Receipt, api } from '../api';
import { Alert, CurrencyPicker, Page, money, normalizeAmount, useAction } from '../ui';

const PRESETS: Record<Currency, string[]> = {
  BOB: ['50', '100', '200', '500'],
  USD: ['20', '50', '100', '500'],
  EUR: ['20', '50', '100', '500'],
};

/** Recarga simulada (en una billetera real sería una transferencia bancaria entrante). */
export default function TopUp() {
  const [currency, setCurrency] = useState<Currency>('BOB');
  const [amount, setAmount] = useState('');
  const [done, setDone] = useState<Receipt | null>(null);
  const action = useAction(async () => {
    const value = normalizeAmount(amount);
    if (!value) throw new Error('Ingresa un monto válido');
    setDone(await api<Receipt>('POST', '/wallet/topups', { currency, amount: value }));
  });

  return (
    <Page title="Recargar saldo" back>
      {done ? (
        <div className="card center success">
          <div className="check">✓</div>
          <h2>Recarga acreditada</h2>
          <p className="big">{money(done.movements[0].amount, done.movements[0].currency)}</p>
          <p className="muted">Saldo: {money(done.movements[0].balanceAfter, done.movements[0].currency)}</p>
          <button className="btn ghost" onClick={() => setDone(null)}>
            Otra recarga
          </button>
        </div>
      ) : (
        <form
          className="card"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void action.run();
          }}
        >
          <Alert kind="info">Simulación: el dinero se acredita al instante, como si llegara una transferencia.</Alert>
          <Alert>{action.error}</Alert>
          <span className="label">Moneda</span>
          <CurrencyPicker value={currency} onChange={setCurrency} options={CURRENCIES} />
          <label>
            Monto
            <input className="amount-input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0,00" required />
          </label>
          <div className="chips">
            {PRESETS[currency].map((p) => (
              <button key={p} type="button" className="chip" onClick={() => setAmount(p)}>
                {money(p, currency)}
              </button>
            ))}
          </div>
          <button className="btn primary" disabled={action.busy}>
            {action.busy ? 'Acreditando…' : 'Recargar'}
          </button>
        </form>
      )}
    </Page>
  );
}
