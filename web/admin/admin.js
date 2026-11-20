// Panel de administración: resumen, usuarios, transacciones, comercios y verificaciones (KYC).
import { api, claims, clearSession, el, login, session } from '/common/session.js';
import { showMerchants, showOverview, showTransactions, showUsers } from '/admin/sections.js';

const root = document.getElementById('root');
const view = el('div', { className: 'view' });
const SECTIONS = [
  ['overview', 'Resumen', () => showOverview(view)],
  ['users', 'Usuarios', () => showUsers(view)],
  ['transactions', 'Transacciones', () => showTransactions(view)],
  ['merchants', 'Comercios', () => showMerchants(view)],
  ['kyc', 'Verificaciones', () => showList()],
];
let section = location.hash.slice(1) || 'overview';
const TABS = [
  ['PENDING', 'Pendientes'],
  ['APPROVED', 'Aprobadas'],
  ['REJECTED', 'Rechazadas'],
];
const STATUS_TEXT = { PENDING: 'En revisión', APPROVED: 'Aprobada', REJECTED: 'Rechazada' };
const DOC_TEXT = { DNI: 'DNI', CEDULA: 'Cédula', PASSPORT: 'Pasaporte' };
let tab = 'PENDING';
let blobUrls = [];

document.getElementById('logout').addEventListener('click', () => {
  clearSession();
  location.reload();
});

async function start() {
  if (!session()) await login(root, 'Panel de administración');
  const me = claims();
  document.getElementById('who').textContent = me?.email ?? '';
  document.getElementById('logout').classList.remove('hidden');
  if (me?.role !== 'ADMIN') {
    root.replaceChildren(el('p', { className: 'alert', textContent: 'Esta cuenta no tiene permisos de administrador.' }));
    return;
  }
  const nav = el('nav', { className: 'sections' });
  const paint = () =>
    nav.replaceChildren(
      ...SECTIONS.map(([key, label, fn]) => {
        const b = el('button', { type: 'button', className: key === section ? 'active' : '', textContent: label });
        b.addEventListener('click', () => {
          section = key;
          location.hash = key;
          paint();
          releaseBlobs();
          view.replaceChildren(el('p', { className: 'muted', textContent: 'Cargando…' }));
          fn().catch(fail);
        });
        return b;
      }),
    );
  paint();
  root.replaceChildren(nav, view);
  await (SECTIONS.find(([k]) => k === section) ?? SECTIONS[0])[2]();
}

function releaseBlobs() {
  blobUrls.forEach((u) => URL.revokeObjectURL(u));
  blobUrls = [];
}

async function showList() {
  releaseBlobs();
  const data = await api('GET', `/kyc/admin/submissions?status=${tab}`);
  const tabs = el('div', { className: 'tabs' },
    ...TABS.map(([key, label]) => {
      const b = el('button', { type: 'button', className: key === tab ? 'active' : '' },
        label, el('span', { className: 'count', textContent: `(${data.counts[key] ?? 0})` }));
      b.addEventListener('click', () => { tab = key; showList().catch(fail); });
      return b;
    }),
  );

  const body = data.items.length
    ? el('div', { className: 'table-wrap' }, el('table', { className: 'list' },
        el('thead', {}, el('tr', {}, ...['Nombre', 'Correo', 'Documento', 'Alertas', 'Enviado'].map((h) => el('th', { textContent: h })))),
        el('tbody', {}, ...data.items.map((it) => {
          const tr = el('tr', { tabIndex: 0 },
            el('td', { textContent: it.fullName }),
            el('td', { textContent: it.email }),
            el('td', { textContent: `${DOC_TEXT[it.documentType]} · ${it.nationality}` }),
            el('td', { textContent: it.warnings ? `⚠ ${it.warnings}` : '—' }),
            el('td', { textContent: new Date(it.createdAt).toLocaleString() }),
          );
          const open = () => showDetail(it.id).catch(fail);
          tr.addEventListener('click', open);
          tr.addEventListener('keydown', (e) => e.key === 'Enter' && open());
          return tr;
        })),
      ))
    : el('p', { className: 'muted', textContent: 'No hay verificaciones en esta lista.' });

  view.replaceChildren(el('section', { className: 'card' }, el('h1', { textContent: 'Verificaciones de identidad' }), tabs, body));
}

async function photo(id, kind, caption) {
  const res = await api('GET', `/kyc/admin/submissions/${id}/files/${kind}`, undefined, { raw: true });
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  blobUrls.push(url);
  const media = blob.type === 'application/pdf'
    ? el('a', { href: url, target: '_blank', rel: 'noopener', textContent: 'Abrir PDF' })
    : el('img', { src: url, alt: caption });
  return el('figure', { className: 'photo' }, media, el('figcaption', { textContent: caption }));
}

async function showDetail(id) {
  releaseBlobs();
  const s = await api('GET', `/kyc/admin/submissions/${id}`);
  const captions = { documentFront: 'Frente del documento', documentBack: 'Dorso del documento', selfie: 'Selfie' };
  const order = Object.keys(captions);
  const kinds = [...s.files].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const photos = await Promise.all(kinds.map((k) => photo(id, k, captions[k])));

  const back = el('button', { type: 'button', className: 'link back', textContent: '← Volver a la lista' });
  back.addEventListener('click', () => showList().catch(fail));

  const rows = [
    ['Estado', STATUS_TEXT[s.status]],
    ['Nombre legal', `${s.firstName} ${s.lastName}`],
    ['Nacimiento', s.birthDate],
    ['Nacionalidad', s.nationality],
    ['Documento', `${DOC_TEXT[s.documentType]} ${s.documentNumber}`],
    ['Vence', s.documentExpiresAt],
    ['Domicilio', `${s.address.line1}, ${s.address.city}, ${s.address.state} (${s.address.postalCode}), ${s.address.country}`],
    ['Teléfono', s.phone],
    ['Ocupación', s.occupation],
    ['Correo de la cuenta', s.email],
    ['Envíos anteriores', String(s.previousSubmissions)],
    ...(s.reviewedAt ? [['Revisado', `${new Date(s.reviewedAt).toLocaleString()} por ${s.reviewedBy ?? 'sistema'}`]] : []),
    ...(s.rejectionReason ? [['Motivo de rechazo', s.rejectionReason]] : []),
  ];

  const info = el('section', { className: 'card' },
    el('h2', { textContent: 'Datos declarados' }),
    el('ul', { className: 'summary' }, ...rows.map(([k, v]) => el('li', {}, el('span', { textContent: k }), el('span', { textContent: v })))),
    el('h2', { textContent: 'Verificaciones automáticas' }),
    el('ul', { className: 'checks' }, ...s.checks.map((c) =>
      el('li', {}, el('span', { className: `chk ${c.result}`, textContent: c.result }),
        el('span', {}, el('strong', { textContent: c.label }), el('br'), el('span', { className: 'muted', textContent: c.detail }))))),
  );

  const side = el('section', { className: 'card' },
    el('h2', { textContent: 'Fotos' }),
    el('p', { className: 'muted small', textContent: 'Compara la selfie con la foto del documento y que los datos coincidan.' }),
    el('div', { className: 'photos' }, ...photos),
  );

  if (s.status === 'PENDING') {
    const alert = el('p', { className: 'alert hidden', role: 'alert' });
    const reason = el('textarea', { placeholder: 'Motivo del rechazo (lo verá el usuario)', maxLength: 300 });
    const approve = el('button', { type: 'button', className: 'primary', textContent: 'Aprobar identidad' });
    const reject = el('button', { type: 'button', className: 'danger', textContent: 'Rechazar' });
    const act = (fn) => async () => {
      alert.classList.add('hidden');
      approve.disabled = reject.disabled = true;
      try { await fn(); await showDetail(id); } catch (e) {
        alert.textContent = e.message;
        alert.classList.remove('hidden');
        approve.disabled = reject.disabled = false;
      }
    };
    approve.addEventListener('click', act(() => api('POST', `/kyc/admin/submissions/${id}/approve`)));
    reject.addEventListener('click', act(() => {
      if (reason.value.trim().length < 5) throw new Error('Escribe el motivo del rechazo (mín. 5 caracteres)');
      return api('POST', `/kyc/admin/submissions/${id}/reject`, { reason: reason.value.trim() });
    }));
    side.append(el('div', { className: 'actions' }, alert, approve, reason, reject));
  }

  view.replaceChildren(back, el('div', { className: 'layout' }, info, side));
}

function fail(e) {
  (view.isConnected ? view : root).prepend(el('p', { className: 'alert', textContent: e.message }));
}

start().catch(fail);
