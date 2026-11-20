import { FormEvent, ReactNode, createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { Currency } from './api';

// ------------------------------------------------------------------ formato

const SYMBOL: Record<string, string> = { USD: 'US$', EUR: '€', ARS: '$' };
const NAME: Record<string, string> = { USD: 'Dólares', EUR: 'Euros', ARS: 'Pesos argentinos' };

export const currencyName = (c: string) => NAME[c] ?? c;

export function money(amount: string | number, currency: Currency | string) {
  const n = Number(amount);
  const txt = Math.abs(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? '-' : ''}${SYMBOL[currency] ?? currency} ${txt}`;
}

export function when(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? `Hoy ${d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}`
    : d.toLocaleDateString('es-AR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Acepta "12,50" o "12.50" y devuelve "12.50" (lo que espera la API). */
export function normalizeAmount(v: string) {
  const s = v.trim().replace(/\s/g, '').replace(',', '.');
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(s)) return null;
  return Number(s) > 0 ? s : null;
}

// ------------------------------------------------------------------ componentes

export function Alert({ children, kind = 'error' }: { children: ReactNode; kind?: 'error' | 'ok' | 'info' }) {
  if (!children) return null;
  return (
    <p className={`alert ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </p>
  );
}

export function Spinner({ label = 'Cargando…' }: { label?: string }) {
  return (
    <div className="spinner" role="status">
      <span className="dot" /> {label}
    </div>
  );
}

export function Page({ title, back, children, action }: { title: string; back?: boolean; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="page">
      <header className="page-head">
        {back && (
          <button type="button" className="icon-btn" aria-label="Volver" onClick={() => history.back()}>
            ←
          </button>
        )}
        <h1>{title}</h1>
        <div className="grow" />
        {action}
      </header>
      {children}
    </section>
  );
}

/** Ejecuta una acción async mostrando estado de carga y error. */
export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = useCallback(
    async (...args: A): Promise<R | undefined> => {
      setBusy(true);
      setError('');
      try {
        return await fn(...args);
      } catch (e) {
        setError((e as Error).message);
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [fn],
  );
  return { run, busy, error, setError };
}

export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setError('');
    fn()
      .then((d) => alive && setData(d))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, reload: () => setTick((t) => t + 1), setData };
}

// ------------------------------------------------------------------ PIN

type PinRequest = { title: string; detail?: string; resolve: (pin: string | null) => void };
const PinCtx = createContext<(title: string, detail?: string) => Promise<string | null>>(async () => null);

/** Pide el PIN de pagos en una hoja modal: `const pin = await askPin('Confirmar envío')`. */
export const usePin = () => useContext(PinCtx);

export function PinProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<PinRequest | null>(null);
  const [pin, setPin] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const ask = useCallback(
    (title: string, detail?: string) =>
      new Promise<string | null>((resolve) => {
        setPin('');
        setReq({ title, detail, resolve });
      }),
    [],
  );
  useEffect(() => {
    if (req) setTimeout(() => input.current?.focus(), 50);
  }, [req]);
  const close = (value: string | null) => {
    req?.resolve(value);
    setReq(null);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (/^\d{4,6}$/.test(pin)) close(pin);
  };
  return (
    <PinCtx.Provider value={ask}>
      {children}
      {req && (
        <div className="sheet-backdrop" onClick={() => close(null)}>
          <form className="sheet" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
            <h2>{req.title}</h2>
            {req.detail && <p className="muted">{req.detail}</p>}
            <label>
              PIN de pagos
              <input
                ref={input}
                className="pin"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={6}
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
              />
            </label>
            <button className="btn primary" disabled={!/^\d{4,6}$/.test(pin)}>
              Confirmar
            </button>
            <button type="button" className="btn ghost" onClick={() => close(null)}>
              Cancelar
            </button>
          </form>
        </div>
      )}
    </PinCtx.Provider>
  );
}

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" aria-label="Cerrar" onClick={onClose}>
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function CurrencyPicker({ value, onChange, options }: { value: Currency; onChange: (c: Currency) => void; options: Currency[] }) {
  return (
    <div className="seg" role="radiogroup">
      {options.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          className={value === c ? 'on' : ''}
          onClick={() => onChange(c)}
        >
          {c}
        </button>
      ))}
    </div>
  );
}

export function Copy({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="copy"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text.replace(/\s/g, label === 'Número' ? '' : ' '));
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* sin permiso de portapapeles */
        }
      }}
    >
      {done ? '✓ Copiado' : 'Copiar'}
    </button>
  );
}
