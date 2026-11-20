import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardDetails, api } from '../api';
import { Alert, Copy, Page, Sheet, Spinner, money, normalizeAmount, useAction, useLoad, usePin, when } from '../ui';

interface Eligibility {
  eligible: boolean;
  requirements: { key: string; label: string; done: boolean; required: boolean }[];
  offer: { product: string; brand: string; currency: string; fundedBy: string; defaultMonthlyLimit: string };
}
interface Auth {
  authorizationId: string;
  status: 'APPROVED' | 'DECLINED';
  message: string;
  merchantName: string;
  amount: string;
  currency: string;
  debited?: string;
  createdAt: string;
}

const REQ_LINK: Record<string, string> = { PIN_SET: '/perfil', IDENTITY_VERIFIED: '/verificar' };

/** Apartado "Tarjetas": habilitar la tarjeta virtual, ver sus datos para pagar online y administrarla. */
export default function Cards() {
  const cards = useLoad(() => api<Card[]>('GET', '/cards'));
  const card = cards.data?.find((c) => c.status !== 'CANCELLED');

  if (!cards.data) return <Page title="Tarjeta">{cards.error ? <Alert>{cards.error}</Alert> : <Spinner />}</Page>;
  return (
    <Page title="Tarjeta">
      {card ? <CardView card={card} reload={cards.reload} /> : <EnableCard onDone={cards.reload} />}
    </Page>
  );
}

function EnableCard({ onDone }: { onDone: () => void }) {
  const askPin = usePin();
  const el = useLoad(() => api<Eligibility>('GET', '/cards/eligibility'));
  const issue = useAction(async () => {
    const pin = await askPin('Habilitar tarjeta virtual');
    if (!pin) return;
    await api('POST', '/cards', { pin });
    onDone();
  });
  if (!el.data) return el.error ? <Alert>{el.error}</Alert> : <Spinner />;
  const { offer } = el.data;
  return (
    <>
      <div className="plastic preview">
        <span className="plastic-brand">{offer.brand}</span>
        <span className="plastic-chip" />
        <span className="plastic-number">•••• •••• •••• ••••</span>
        <span className="plastic-name">TU NOMBRE</span>
      </div>
      <div className="card">
        <h2>{offer.product}</h2>
        <p className="muted">
          Tarjeta {offer.brand} en {offer.currency} para comprar online y en comercios. Se paga con el saldo en {offer.currency} de tu
          billetera. Sin costo de emisión ni mantenimiento.
        </p>
        <span className="label">Requisitos</span>
        <ul className="reqs">
          {el.data.requirements
            .filter((r) => r.required)
            .map((r) => (
              <li key={r.key} className={r.done ? 'done' : ''}>
                <span aria-hidden>{r.done ? '✓' : '○'}</span> {r.label}
                {!r.done && REQ_LINK[r.key] && (
                  <Link to={REQ_LINK[r.key]} className="link">
                    Completar
                  </Link>
                )}
              </li>
            ))}
        </ul>
        <Alert>{issue.error}</Alert>
        <button className="btn primary" disabled={!el.data.eligible || issue.busy} onClick={() => void issue.run()}>
          {issue.busy ? 'Emitiendo…' : 'Habilitar tarjeta'}
        </button>
      </div>
    </>
  );
}

function CardView({ card, reload }: { card: Card; reload: () => void }) {
  const askPin = usePin();
  const [details, setDetails] = useState<CardDetails | null>(null);
  const [limitOpen, setLimitOpen] = useState(false);
  const [txOpen, setTxOpen] = useState(false);
  const frozen = card.status === 'FROZEN';
  const used = Math.min(100, (Number(card.spentThisMonth) / Number(card.monthlyLimit)) * 100);

  const reveal = useAction(async () => {
    const pin = await askPin('Ver datos de la tarjeta');
    if (!pin) return;
    setDetails(await api<CardDetails>('POST', `/cards/${card.id}/details`, { pin }));
  });
  const toggle = useAction(async () => {
    await api('POST', `/cards/${card.id}/${frozen ? 'unfreeze' : 'freeze'}`);
    reload();
  });
  const cancel = useAction(async () => {
    if (!confirm('¿Dar de baja la tarjeta? No se puede deshacer; luego podrás pedir una nueva.')) return;
    const pin = await askPin('Dar de baja la tarjeta');
    if (!pin) return;
    await api('POST', `/cards/${card.id}/cancel`, { pin });
    reload();
  });

  return (
    <>
      <div className={`plastic ${frozen ? 'frozen' : ''}`}>
        <span className="plastic-brand">{card.brand}</span>
        <span className="plastic-chip" />
        <span className="plastic-number">{details ? details.number : card.maskedNumber}</span>
        <span className="plastic-name">{card.holderName}</span>
        <span className="plastic-exp">{card.expiry}</span>
        {frozen && <span className="plastic-badge">Pausada</span>}
      </div>

      <Alert>{reveal.error || toggle.error || cancel.error}</Alert>
      <div className="card-actions">
        <button className="action" onClick={() => (details ? setDetails(null) : void reveal.run())} disabled={reveal.busy}>
          <span className="action-icon">{details ? '🙈' : '👁'}</span>
          {details ? 'Ocultar' : 'Ver datos'}
        </button>
        <button className="action" onClick={() => void toggle.run()} disabled={toggle.busy}>
          <span className="action-icon">{frozen ? '▶' : '❄'}</span>
          {frozen ? 'Reactivar' : 'Pausar'}
        </button>
        <button className="action" onClick={() => setLimitOpen(true)}>
          <span className="action-icon">⚙</span>
          Límite
        </button>
        <button className="action" onClick={() => setTxOpen(true)}>
          <span className="action-icon">☰</span>
          Compras
        </button>
      </div>

      {details && (
        <div className="card">
          <h2>Datos para pagar online</h2>
          <p className="muted small">No los compartas. Úsalos solo en tiendas de confianza.</p>
          <dl className="kv copyable">
            <dt>Número</dt>
            <dd>
              <span className="mono">{details.number}</span> <Copy text={details.number} label="Número" />
            </dd>
            <dt>Vencimiento</dt>
            <dd>
              <span className="mono">{details.expiry}</span> <Copy text={details.expiry} label="Vencimiento" />
            </dd>
            <dt>CVV</dt>
            <dd>
              <span className="mono">{details.cvv}</span> <Copy text={details.cvv} label="CVV" />
            </dd>
            <dt>Titular</dt>
            <dd>{details.holderName}</dd>
            <dt>Facturación</dt>
            <dd>
              {details.billingAddress.line1}, {details.billingAddress.city}, {details.billingAddress.state} {details.billingAddress.postalCode},{' '}
              {details.billingAddress.country}
            </dd>
          </dl>
        </div>
      )}

      <div className="card">
        <div className="row-between">
          <span className="muted">Gastado este mes</span>
          <strong>
            {money(card.spentThisMonth, card.currency)} / {money(card.monthlyLimit, card.currency)}
          </strong>
        </div>
        <div className="meter" aria-label={`${used.toFixed(0)}% del límite usado`}>
          <span style={{ width: `${used}%` }} />
        </div>
        <p className="muted small">Disponible: {money(card.availableThisMonth, card.currency)}. Se debita del saldo en USD.</p>
      </div>

      <button className="btn ghost danger" onClick={() => void cancel.run()} disabled={cancel.busy}>
        Dar de baja la tarjeta
      </button>

      {limitOpen && <LimitSheet card={card} onClose={() => setLimitOpen(false)} onDone={reload} />}
      {txOpen && <TxSheet cardId={card.id} onClose={() => setTxOpen(false)} />}
    </>
  );
}

function LimitSheet({ card, onClose, onDone }: { card: Card; onClose: () => void; onDone: () => void }) {
  const [value, setValue] = useState(String(Number(card.monthlyLimit)));
  const save = useAction(async () => {
    const v = normalizeAmount(value);
    if (!v) throw new Error('Monto inválido');
    await api('PATCH', `/cards/${card.id}/limit`, { monthlyLimit: v });
    onDone();
    onClose();
  });
  return (
    <Sheet title="Límite mensual" onClose={onClose}>
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void save.run();
        }}
      >
        <Alert>{save.error}</Alert>
        <label>
          Límite en USD
          <input className="amount-input" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
        <button className="btn primary" disabled={save.busy}>
          Guardar
        </button>
      </form>
    </Sheet>
  );
}

function TxSheet({ cardId, onClose }: { cardId: string; onClose: () => void }) {
  const tx = useLoad(() => api<Auth[]>('GET', `/cards/${cardId}/transactions`));
  return (
    <Sheet title="Compras con la tarjeta" onClose={onClose}>
      <Alert>{tx.error}</Alert>
      {!tx.data && !tx.error && <Spinner />}
      <ul className="list">
        {tx.data?.length === 0 && <li className="empty">Todavía no usaste la tarjeta.</li>}
        {tx.data?.map((a) => (
          <li key={a.authorizationId} className="mov static">
            <span className={`mov-icon ${a.status === 'APPROVED' ? 'OUT' : 'DECLINED'}`}>{a.status === 'APPROVED' ? '▭' : '✕'}</span>
            <span className="mov-main">
              <strong>{a.merchantName}</strong>
              <small className="muted">
                {a.status === 'APPROVED' ? 'Aprobada' : `Rechazada: ${a.message}`} · {when(a.createdAt)}
              </small>
            </span>
            <span className={`mov-amount ${a.status === 'APPROVED' ? 'OUT' : 'muted'}`}>{money(a.amount, a.currency)}</span>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}
