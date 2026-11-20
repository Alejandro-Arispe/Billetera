import { Html5Qrcode } from 'html5-qrcode';
import { FormEvent, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Currency, api } from '../api';
import { useMe } from '../App';
import { Alert, Page, money, useAction, usePin } from '../ui';

interface Intent {
  intentId: string;
  status: string;
  merchant: { id: string; name: string };
  amount: string;
  currency: Currency;
  description: string;
  items: { name: string; quantity: number; unitPrice: string }[];
  expiresAt: string;
  fundingOptions: { currency: Currency; balance: string; debit: string; rate: string | null; sufficient: boolean }[];
}
interface Paid {
  amount: string;
  currency: Currency;
  merchant: { name: string };
  transactionId: string;
  debited: string;
  debitedCurrency: Currency;
  rate: string | null;
}

/** Pagar con QR: escanear con la cámara (o pegar el texto), elegir cuenta y confirmar con PIN. */
export default function Scan() {
  const { me } = useMe();
  const askPin = usePin();
  const [intent, setIntent] = useState<Intent | null>(null);
  const [funding, setFunding] = useState<Currency | null>(null);
  const [paid, setPaid] = useState<Paid | null>(null);
  const [left, setLeft] = useState(0);

  const open = useAction(async (qr: string) => {
    const i = await api<Intent>('POST', '/payments/qr/scan', { qr });
    setIntent(i);
    const pref = i.fundingOptions.find((o) => o.currency === i.currency && o.sufficient) ?? i.fundingOptions.find((o) => o.sufficient);
    setFunding(pref?.currency ?? null);
  });
  const pay = useAction(async () => {
    if (!intent || !funding) return;
    const opt = intent.fundingOptions.find((o) => o.currency === funding)!;
    const pin = await askPin(`Pagar ${money(intent.amount, intent.currency)}`, `a ${intent.merchant.name} · se debita ${money(opt.debit, funding)}`);
    if (!pin) return;
    setPaid(await api<Paid>('POST', `/payments/qr/${intent.intentId}/pay`, { pin, fundingCurrency: funding }));
  });

  useEffect(() => {
    if (!intent) return;
    const tick = () => setLeft(Math.max(0, Math.round((new Date(intent.expiresAt).getTime() - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [intent]);

  if (!me?.hasPin) {
    return (
      <Page title="Pagar con QR">
        <Alert kind="info">Para pagar primero configura tu PIN de pagos.</Alert>
        <Link to="/perfil" className="btn primary">
          Configurar PIN
        </Link>
      </Page>
    );
  }

  if (paid) {
    return (
      <Page title="Pagar con QR">
        <div className="card center success">
          <div className="check">✓</div>
          <h2>¡Pago realizado!</h2>
          <p className="big">{money(paid.amount, paid.currency)}</p>
          <p>a {paid.merchant.name}</p>
          {paid.debitedCurrency !== paid.currency && (
            <p className="muted small">
              Se debitaron {money(paid.debited, paid.debitedCurrency)} (tasa {Number(paid.rate).toFixed(4)})
            </p>
          )}
          <p className="muted small mono">Operación {paid.transactionId}</p>
          <button
            className="btn ghost"
            onClick={() => {
              setPaid(null);
              setIntent(null);
            }}
          >
            Escanear otro QR
          </button>
        </div>
      </Page>
    );
  }

  if (intent) {
    return (
      <Page title="Confirmar pago" back>
        <div className="card">
          <p className="muted">Pagar a</p>
          <h2>{intent.merchant.name}</h2>
          <p className="big">{money(intent.amount, intent.currency)}</p>
          <p className="muted">{intent.description}</p>
          {intent.items.length > 0 && (
            <ul className="items">
              {intent.items.map((it, i) => (
                <li key={i}>
                  <span>
                    {it.quantity} × {it.name}
                  </span>
                  <span>{(Number(it.unitPrice) * it.quantity).toFixed(2)}</span>
                </li>
              ))}
            </ul>
          )}
          <p className={`muted small ${left < 30 ? 'warn-text' : ''}`}>
            {left > 0 ? `El QR vence en ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : 'El QR venció'}
          </p>

          <span className="label">Pagar con</span>
          <div className="options">
            {intent.fundingOptions.map((o) => (
              <label key={o.currency} className={`option ${o.sufficient ? '' : 'disabled'} ${funding === o.currency ? 'on' : ''}`}>
                <input type="radio" name="funding" checked={funding === o.currency} disabled={!o.sufficient} onChange={() => setFunding(o.currency)} />
                <strong>{money(o.debit, o.currency)}</strong>
                <span className="muted small">
                  Saldo {money(o.balance, o.currency)}
                  {!o.sufficient && ' · insuficiente'}
                </span>
              </label>
            ))}
          </div>
          <Alert>{pay.error || (!funding ? 'No tienes saldo suficiente en ninguna cuenta.' : '')}</Alert>
          <button className="btn primary" onClick={() => void pay.run()} disabled={!funding || left === 0 || pay.busy}>
            {pay.busy ? 'Pagando…' : 'Pagar'}
          </button>
          <button className="btn ghost" onClick={() => setIntent(null)}>
            Cancelar
          </button>
        </div>
      </Page>
    );
  }

  return (
    <Page title="Pagar con QR">
      <Alert>{open.error}</Alert>
      <Scanner onResult={(text) => void open.run(text)} busy={open.busy} />
      <PasteForm onSubmit={(t) => void open.run(t)} busy={open.busy} />
    </Page>
  );
}

function Scanner({ onResult, busy }: { onResult: (text: string) => void; busy: boolean }) {
  const ref = useRef<Html5Qrcode | null>(null);
  const [on, setOn] = useState(false);
  const [error, setError] = useState('');

  const stop = async () => {
    if (ref.current?.isScanning) await ref.current.stop().catch(() => undefined);
    setOn(false);
  };
  useEffect(() => () => void stop(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async () => {
    setError('');
    try {
      ref.current ??= new Html5Qrcode('qr-reader');
      setOn(true);
      await ref.current.start({ facingMode: 'environment' }, { fps: 10, qrbox: 230 }, async (text) => {
        await stop();
        onResult(text);
      }, undefined);
    } catch {
      setOn(false);
      setError(
        window.isSecureContext
          ? 'No se pudo abrir la cámara. Revisa el permiso del navegador.'
          : 'El navegador solo permite la cámara en https o localhost. Usa la cámara del teléfono para abrir el QR, o pega su contenido abajo.',
      );
    }
  };

  return (
    <div className="card scanner">
      <div id="qr-reader" className={on ? 'reader on' : 'reader'} />
      {!on && (
        <div className="scan-placeholder" aria-hidden>
          ▣
        </div>
      )}
      <Alert>{error}</Alert>
      {on ? (
        <button className="btn ghost" onClick={() => void stop()}>
          Detener cámara
        </button>
      ) : (
        <button className="btn primary" onClick={() => void start()} disabled={busy}>
          {busy ? 'Abriendo cobro…' : 'Escanear QR'}
        </button>
      )}
    </div>
  );
}

function PasteForm({ onSubmit, busy }: { onSubmit: (t: string) => void; busy: boolean }) {
  const [text, setText] = useState('');
  return (
    <form
      className="card"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (text.trim()) onSubmit(text.trim());
      }}
    >
      <label>
        …o pega el contenido del QR
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="http://…/pay?i=…&s=…" />
      </label>
      <button className="btn ghost" disabled={busy || !text.trim()}>
        Abrir cobro
      </button>
    </form>
  );
}
