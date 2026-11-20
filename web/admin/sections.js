// Secciones del panel: resumen, usuarios, transacciones y comercios.
import { api, el } from '/common/session.js';

const TYPE_TEXT = {
  TOPUP: 'Recarga',
  P2P_TRANSFER: 'Transferencia',
  FX_CONVERSION: 'Cambio de moneda',
  CARD_PAYMENT: 'Compra con tarjeta',
  QR_PAYMENT: 'Pago QR',
  REFUND: 'Reintegro',
};
const STATUS_TEXT = { ACTIVE: 'Activo', PENDING_EMAIL: 'Sin verificar correo', BLOCKED: 'Bloqueado' };
const KYC_TEXT = { NOT_STARTED: 'Sin verificar', PENDING: 'En revisión', APPROVED: 'Verificada', REJECTED: 'Rechazada' };
const fmt = (n, c) => `${c} ${Number(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const date = (d) => (d ? new Date(d).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' }) : '—');

function table(headers, rows) {
  return el('div', { className: 'table-wrap' }, el('table', { className: 'list static' },
    el('thead', {}, el('tr', {}, ...headers.map((h) => el('th', { textContent: h })))),
    el('tbody', {}, ...rows),
  ));
}
const td = (text, className = '') => el('td', { textContent: text ?? '—', className });
const stat = (label, value, hint) =>
  el('div', { className: 'stat' }, el('span', { className: 'muted small', textContent: label }), el('strong', { textContent: value }),
    hint ? el('span', { className: 'muted small', textContent: hint }) : null);

// ------------------------------------------------------------------ resumen
export async function showOverview(view) {
  const [users, money, shops, kyc] = await Promise.all([
    api('GET', '/auth/admin/stats'),
    api('GET', '/wallet/admin/stats'),
    api('GET', '/payments/admin/merchants'),
    api('GET', '/kyc/admin/submissions?status=PENDING'),
  ]);
  const tx24 = money.transactions.reduce((s, t) => s + t.last24h, 0);
  const txAll = money.transactions.reduce((s, t) => s + t.total, 0);

  view.replaceChildren(
    el('div', { className: 'stats' },
      stat('Usuarios', String(users.total), `${users.last24h} nuevos en 24 h`),
      stat('Identidad verificada', String(users.byKyc.APPROVED ?? 0), `${kyc.counts.PENDING ?? 0} esperando revisión`),
      stat('Operaciones', String(txAll), `${tx24} en las últimas 24 h`),
      stat('Comercios', String(shops.items.length), `${shops.failedWebhooks} webhooks fallidos`),
    ),
    el('div', { className: 'layout' },
      el('section', { className: 'card' },
        el('h2', { textContent: 'Dinero de los usuarios' }),
        el('ul', { className: 'summary' }, ...money.userBalances.map((b) =>
          el('li', {}, el('span', { textContent: `${b.currency} · ${b.accountsWithFunds} cuentas con saldo` }), el('strong', { textContent: fmt(b.total, b.currency) })))),
        el('p', {
          className: `alert ${money.ledger.balanced ? 'ok-box' : ''}`,
          textContent: money.ledger.balanced
            ? '✓ Ledger cuadrado: los asientos suman 0 en cada moneda y cada saldo coincide con sus movimientos.'
            : `⚠ Ledger descuadrado en ${money.ledger.accountsWithMismatch.length} cuenta(s). Revisar.`,
        }),
      ),
      el('section', { className: 'card' },
        el('h2', { textContent: 'Operaciones por tipo' }),
        table(['Tipo', 'Total', '24 h'], money.transactions.map((t) => el('tr', {}, td(TYPE_TEXT[t.type] ?? t.type), td(String(t.total)), td(String(t.last24h)))))
        ,
        el('h2', { textContent: 'Volumen 24 h', className: 'mt' }),
        money.volume24h.length
          ? table(['Tipo', 'Monto'], money.volume24h.map((v) => el('tr', {}, td(TYPE_TEXT[v.type] ?? v.type), td(fmt(v.total, v.currency)))))
          : el('p', { className: 'muted', textContent: 'Sin movimientos en las últimas 24 h.' }),
      ),
    ),
  );
}

// ------------------------------------------------------------------ usuarios
export async function showUsers(view, q = '') {
  const data = await api('GET', `/auth/admin/users${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  const search = el('input', { type: 'search', placeholder: 'Buscar por correo o nombre…', value: q });
  const form = el('form', { className: 'search' }, search, el('button', { className: 'primary', type: 'submit', textContent: 'Buscar' }));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    showUsers(view, search.value.trim()).catch((err) => alert(err.message));
  });

  const rows = data.items.map((u) => {
    const act = el('button', { type: 'button', className: u.status === 'BLOCKED' ? 'secondary small' : 'danger small' });
    act.textContent = u.status === 'BLOCKED' ? 'Desbloquear' : 'Bloquear';
    act.hidden = u.role === 'ADMIN' || u.status === 'PENDING_EMAIL';
    act.addEventListener('click', async () => {
      const blocking = u.status !== 'BLOCKED';
      if (blocking && !confirm(`¿Bloquear a ${u.email}? No podrá ingresar ni mover dinero.`)) return;
      act.disabled = true;
      try {
        await api('POST', `/auth/admin/users/${u.id}/${blocking ? 'block' : 'unblock'}`);
        await showUsers(view, q);
      } catch (err) {
        alert(err.message);
        act.disabled = false;
      }
    });
    return el('tr', {},
      td(u.fullName), td(u.email), td(u.role === 'ADMIN' ? 'Admin' : 'Usuario'),
      td(STATUS_TEXT[u.status] ?? u.status, `st-${u.status}`), td(KYC_TEXT[u.kycStatus]), td(date(u.createdAt)),
      el('td', {}, act));
  });

  view.replaceChildren(el('section', { className: 'card' },
    el('h1', { textContent: `Usuarios (${data.total})` }),
    form,
    data.items.length ? table(['Nombre', 'Correo', 'Rol', 'Estado', 'Identidad', 'Alta', ''], rows) : el('p', { className: 'muted', textContent: 'Sin resultados.' }),
  ));
}

// ------------------------------------------------------------------ transacciones
export async function showTransactions(view, type = '') {
  const [txs, users] = await Promise.all([
    api('GET', `/wallet/admin/transactions${type ? `?type=${type}` : ''}`),
    api('GET', '/auth/admin/users'),
  ]);
  const names = new Map(users.items.map((u) => [u.id, u.email]));
  const filter = el('div', { className: 'tabs' }, ...[['', 'Todas'], ...Object.entries(TYPE_TEXT)].map(([k, label]) => {
    const b = el('button', { type: 'button', className: k === type ? 'active' : '', textContent: label });
    b.addEventListener('click', () => showTransactions(view, k).catch((err) => alert(err.message)));
    return b;
  }));
  const leg = (e) => {
    const who = e.account.userId ? names.get(e.account.userId) ?? `${e.account.userId.slice(0, 8)}…` : `⚙ ${e.account.system}`;
    return el('div', { className: 'leg' }, el('span', { textContent: who }),
      el('span', { className: Number(e.amount) < 0 ? 'neg' : 'pos', textContent: fmt(e.amount, e.currency) }));
  };
  view.replaceChildren(el('section', { className: 'card' },
    el('h1', { textContent: 'Transacciones' }),
    el('p', { className: 'muted small', textContent: 'Cada operación muestra sus asientos de doble entrada: lo que sale de una cuenta entra en otra.' }),
    filter,
    txs.length
      ? table(['Fecha', 'Tipo', 'Detalle', 'Asientos'], txs.map((t) => el('tr', {},
          td(date(t.createdAt)), td(TYPE_TEXT[t.type] ?? t.type), td(t.description), el('td', {}, ...t.entries.map(leg)))))
      : el('p', { className: 'muted', textContent: 'Sin transacciones.' }),
  ));
}

// ------------------------------------------------------------------ comercios
export async function showMerchants(view) {
  const [data, users] = await Promise.all([api('GET', '/payments/admin/merchants'), api('GET', '/auth/admin/users')]);
  const names = new Map(users.items.map((u) => [u.id, u.email]));
  view.replaceChildren(el('section', { className: 'card' },
    el('h1', { textContent: `Comercios (${data.items.length})` }),
    data.failedWebhooks
      ? el('p', { className: 'alert', textContent: `${data.failedWebhooks} webhook(s) agotaron sus reintentos sin entregarse.` })
      : null,
    data.items.length
      ? table(['Comercio', 'Dueño', 'Cobros', 'Pagados', 'Volumen cobrado', 'Webhook', 'Última actividad'], data.items.map((m) => el('tr', {},
          td(m.name), td(names.get(m.ownerUserId) ?? m.ownerUserId.slice(0, 8)), td(String(m.intents)), td(String(m.paid)),
          td(m.volume.map((v) => fmt(v.total, v.currency)).join(' · ') || '—'),
          td(m.webhookUrl ?? 'sin configurar', 'small break'), td(date(m.lastActivity)))))
      : el('p', { className: 'muted', textContent: 'Todavía no hay comercios.' }),
  ));
}
