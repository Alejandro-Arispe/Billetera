import { FormEvent, useEffect, useState } from 'react';
import { Account, CURRENCIES, Currency, Receipt, api } from '../api';
import { Alert, CurrencyPicker, Page, money, normalizeAmount, useAction, useLoad } from '../ui';

interface Quote {
  quoteId: string;
  from: Currency;
  to: Currency;
  amountFrom: string;
  amountTo: string;
  rate: string;
  expiresAt: string;
}
interface Rates {
  source: string;
  fetchedAt: string;
  pairs: { from: Currency; to: Currency; mid: number; customer: number }[];
}

/** Cambio de moneda: cotiza con tasa real (válida 30 s) y luego confirma. */
export default function Exchange() {
  const accounts = useLoad(() => api<Account[]>('GET', '/wallet/accounts'));
  const rates = useLoad(() => api<Rates>('GET', '/wallet/fx/rates'));
  const [from, setFrom] = useState<Currency>('USD');
  const [to, setTo] = useState<Currency>('ARS');
  const [amount, setAmount] = useState('');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [left, setLeft] = useState(0);
  const [done, setDone] = useState<Receipt | null>(null);

  useEffect(() => {
    if (!quote) return;
    const tick = () => setLeft(Math.max(0, Math.round((new Date(quote.expiresAt).getTime() - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 500);
    return () => clearInterval(t);
  }, [quote]);

  const balance = accounts.data?.find((a) => a.currency === from)?.balance ?? '0.00';
  const pair = rates.data?.pairs.find((p) => p.from === from && p.to === to);

  const getQuote = useAction(async () => {
    const value = normalizeAmount(amount);
    if (!value) throw new Error('Ingresa un monto válido');
    if (Number(value) > Number(balance)) throw new Error('No tienes saldo suficiente');
    setQuote(await api<Quote>('POST', '/wallet/fx/quotes', { from, to, amount: value }));
  });
  const convert = useAction(async () => {
    setDone(await api<Receipt>('POST', '/wallet/fx/convert', { quoteId: quote!.quoteId }));
    accounts.reload();
  });

  const pickFrom = (c: Currency) => {
    setFrom(c);
    if (c === to) setTo(CURRENCIES.find((x) => x !== c)!);
    setQuote(null);
  };

  if (done) {
    return (
      <Page title="Cambiar moneda" back>
        <div className="card center success">
          <div className="check">✓</div>
          <h2>Cambio realizado</h2>
          {done.movements.map((m) => (
            <p key={m.currency} className={Number(m.amount) > 0 ? 'big' : 'muted'}>
              {Number(m.amount) > 0 ? '+' : ''}
              {money(m.amount, m.currency)}
            </p>
          ))}
          <button
            className="btn ghost"
            onClick={() => {
              setDone(null);
              setQuote(null);
              setAmount('');
            }}
          >
            Hacer otro cambio
          </button>
        </div>
      </Page>
    );
  }

  return (
    <Page title="Cambiar moneda" back>
      <div className="card">
        <Alert>{getQuote.error || convert.error || rates.error}</Alert>
        <span className="label">Vendo</span>
        <CurrencyPicker value={from} onChange={pickFrom} options={CURRENCIES} />
        <span className="label">Compro</span>
        <CurrencyPicker
          value={to}
          onChange={(c) => {
            setTo(c);
            setQuote(null);
          }}
          options={CURRENCIES.filter((c) => c !== from)}
        />
        {pair && (
          <p className="rate">
            1 {from} = <strong>{pair.customer.toLocaleString('es-AR', { maximumFractionDigits: 4 })}</strong> {to}
            <small className="muted"> · mercado {pair.mid.toLocaleString('es-AR', { maximumFractionDigits: 4 })} · fuente {rates.data?.source}</small>
          </p>
        )}

        {!quote ? (
          <form
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void getQuote.run();
            }}
          >
            <label>
              Monto a vender
              <input className="amount-input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0,00" required />
              <small className="muted">Disponible: {money(balance, from)}</small>
            </label>
            <button className="btn primary" disabled={getQuote.busy}>
              {getQuote.busy ? 'Cotizando…' : 'Cotizar'}
            </button>
          </form>
        ) : (
          <div className="quote">
            <p className="muted">Vendes</p>
            <p className="big">{money(quote.amountFrom, quote.from)}</p>
            <p className="muted">Recibes</p>
            <p className="big ok">{money(quote.amountTo, quote.to)}</p>
            <p className="muted small">
              Tasa {Number(quote.rate).toFixed(4)} · {left > 0 ? `válida ${left} s` : 'cotización vencida'}
            </p>
            {left > 0 ? (
              <button className="btn primary" onClick={() => void convert.run()} disabled={convert.busy}>
                {convert.busy ? 'Cambiando…' : 'Confirmar cambio'}
              </button>
            ) : (
              <button className="btn primary" onClick={() => void getQuote.run()}>
                Volver a cotizar
              </button>
            )}
            <button className="btn ghost" onClick={() => setQuote(null)}>
              Cambiar monto
            </button>
          </div>
        )}
      </div>
    </Page>
  );
}
