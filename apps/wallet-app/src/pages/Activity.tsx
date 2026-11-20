import { useState } from 'react';
import { CURRENCIES, Currency, Movement, Receipt, api } from '../api';
import { Alert, Page, Sheet, Spinner, money, useLoad, when } from '../ui';

const TYPE_LABEL: Record<Movement['type'], string> = {
  TOPUP: 'Recarga',
  P2P_TRANSFER: 'Transferencia',
  FX_CONVERSION: 'Cambio de moneda',
  CARD_PAYMENT: 'Compra con tarjeta',
  QR_PAYMENT: 'Pago con QR',
  REFUND: 'Reintegro',
};
const TYPE_ICON: Record<Movement['type'], string> = {
  TOPUP: '＋',
  P2P_TRANSFER: '↗',
  FX_CONVERSION: '⇄',
  CARD_PAYMENT: '▭',
  QR_PAYMENT: '▣',
  REFUND: '↩',
};

export function MovementRow({ m, onClick }: { m: Movement; onClick?: () => void }) {
  const title =
    m.type === 'P2P_TRANSFER' && m.counterparty
      ? m.direction === 'IN'
        ? `De ${m.counterparty}`
        : `A ${m.counterparty}`
      : m.type === 'QR_PAYMENT' && m.counterparty
        ? m.direction === 'IN'
          ? `Cobro de ${m.counterparty}`
          : m.counterparty
        : m.type === 'CARD_PAYMENT' && m.counterparty
          ? m.counterparty
          : TYPE_LABEL[m.type];
  return (
    <li>
      <button type="button" className="mov" onClick={onClick} disabled={!onClick}>
        <span className={`mov-icon ${m.direction}`} aria-hidden>
          {TYPE_ICON[m.type]}
        </span>
        <span className="mov-main">
          <strong>{title}</strong>
          <small className="muted">
            {TYPE_LABEL[m.type]} · {when(m.createdAt)}
          </small>
        </span>
        <span className={`mov-amount ${m.direction}`}>
          {m.direction === 'IN' ? '+' : '−'}
          {money(m.amount, m.currency)}
        </span>
      </button>
    </li>
  );
}

export default function Activity() {
  const [currency, setCurrency] = useState<Currency | ''>('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const list = useLoad(
    () =>
      api<{ items: Movement[]; total: number; limit: number }>(
        'GET',
        `/wallet/transactions?page=${page}&limit=20${currency ? `&currency=${currency}` : ''}`,
      ),
    [currency, page],
  );
  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.limit)) : 1;

  return (
    <Page title="Actividad">
      <div className="chips">
        {(['', ...CURRENCIES] as const).map((c) => (
          <button
            key={c || 'all'}
            type="button"
            className={currency === c ? 'chip on' : 'chip'}
            onClick={() => {
              setCurrency(c);
              setPage(1);
            }}
          >
            {c || 'Todas'}
          </button>
        ))}
      </div>
      <Alert>{list.error}</Alert>
      {!list.data && !list.error && <Spinner />}
      <ul className="list card">
        {list.data?.items.length === 0 && <li className="empty">Sin movimientos.</li>}
        {list.data?.items.map((m, i) => (
          <MovementRow key={`${m.transactionId}-${i}`} m={m} onClick={() => setOpen(m.transactionId)} />
        ))}
      </ul>
      {pages > 1 && (
        <div className="row-between pager">
          <button className="btn ghost small" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            ← Anterior
          </button>
          <span className="muted">
            {page} / {pages}
          </span>
          <button className="btn ghost small" disabled={page >= pages} onClick={() => setPage(page + 1)}>
            Siguiente →
          </button>
        </div>
      )}
      {open && <ReceiptSheet id={open} onClose={() => setOpen(null)} />}
    </Page>
  );
}

export function ReceiptSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const r = useLoad(() => api<Receipt>('GET', `/wallet/transactions/${id}`), [id]);
  return (
    <Sheet title="Comprobante" onClose={onClose}>
      <Alert>{r.error}</Alert>
      {!r.data && !r.error && <Spinner />}
      {r.data && (
        <>
          <p className="receipt-type">{TYPE_LABEL[r.data.type]}</p>
          {r.data.movements.map((mv) => (
            <p key={mv.currency} className={`receipt-amount ${Number(mv.amount) >= 0 ? 'IN' : 'OUT'}`}>
              {Number(mv.amount) >= 0 ? '+' : ''}
              {money(mv.amount, mv.currency)}
            </p>
          ))}
          <dl className="kv">
            <dt>Detalle</dt>
            <dd>{r.data.description}</dd>
            {r.data.counterparty && (
              <>
                <dt>Contraparte</dt>
                <dd>{r.data.counterparty}</dd>
              </>
            )}
            {r.data.rate && (
              <>
                <dt>Tipo de cambio</dt>
                <dd>{Number(r.data.rate).toFixed(4)}</dd>
              </>
            )}
            <dt>Fecha</dt>
            <dd>{new Date(r.data.createdAt).toLocaleString('es-AR')}</dd>
            <dt>Estado</dt>
            <dd>{r.data.status === 'COMPLETED' ? 'Completada' : r.data.status}</dd>
            <dt>N.º de operación</dt>
            <dd className="mono small">{r.data.transactionId}</dd>
          </dl>
        </>
      )}
    </Sheet>
  );
}
