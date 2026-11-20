// "Verificar identidad": formulario de datos + fotos del documento y selfie.
import { api, clearSession, el, login, session } from '/common/session.js';

const root = document.getElementById('root');
const COUNTRIES = [
  ['AR', 'Argentina'], ['BO', 'Bolivia'], ['BR', 'Brasil'], ['CL', 'Chile'], ['CO', 'Colombia'],
  ['CR', 'Costa Rica'], ['EC', 'Ecuador'], ['ES', 'España'], ['US', 'Estados Unidos'], ['GT', 'Guatemala'],
  ['HN', 'Honduras'], ['MX', 'México'], ['NI', 'Nicaragua'], ['PA', 'Panamá'], ['PY', 'Paraguay'],
  ['PE', 'Perú'], ['DO', 'República Dominicana'], ['SV', 'El Salvador'], ['UY', 'Uruguay'], ['VE', 'Venezuela'],
];
const STATUS_TEXT = {
  NOT_STARTED: 'Sin verificar',
  PENDING: 'En revisión',
  APPROVED: 'Verificada',
  REJECTED: 'Rechazada',
};

document.getElementById('logout').addEventListener('click', () => {
  clearSession();
  location.reload();
});

async function start() {
  if (!session()) await login(root, 'Inicia sesión para verificar tu identidad');
  document.getElementById('logout').classList.remove('hidden');
  render(await api('GET', '/kyc/status'));
}

function render(st) {
  root.replaceChildren(statusCard(st));
  if (st.canSubmit) root.append(buildForm());
}

function statusCard(st) {
  const s = st.submission;
  const icon = { NOT_STARTED: '🪪', PENDING: '⏳', APPROVED: '✅', REJECTED: '⚠️' }[st.status];
  const text = {
    NOT_STARTED: 'Verifica tu identidad para habilitar tu tarjeta virtual y usar todos los servicios.',
    PENDING: 'Recibimos tus datos. Un analista los está revisando; te avisaremos por correo.',
    APPROVED: 'Tu identidad está verificada. Ya puedes habilitar tu tarjeta en el apartado Tarjetas.',
    REJECTED: 'No pudimos verificar tu identidad. Corrige los datos y vuelve a enviarlos.',
  }[st.status];
  const card = el('section', { className: 'card center' },
    el('div', { className: 'big-icon', textContent: icon }),
    el('span', { className: `badge ${st.status}`, textContent: STATUS_TEXT[st.status] }),
    el('p', { textContent: text }),
  );
  if (st.rejectionReason) card.append(el('p', { className: 'alert', textContent: `Motivo: ${st.rejectionReason}` }));
  if (s && st.status !== 'REJECTED') {
    card.append(el('ul', { className: 'summary' },
      ...[
        ['Nombre', `${s.firstName} ${s.lastName}`],
        ['Documento', `${s.documentType} ${s.documentNumberMasked}`],
        ['Nacionalidad', s.nationality],
        ['Enviado', new Date(s.createdAt).toLocaleString()],
      ].map(([k, v]) => el('li', {}, el('span', { textContent: k }), el('span', { textContent: v }))),
    ));
  }
  return card;
}

function buildForm() {
  const frag = document.getElementById('tpl-form').content.cloneNode(true);
  const form = frag.querySelector('form');
  form.querySelectorAll('[data-countries]').forEach((sel) => {
    sel.append(el('option', { value: '', textContent: 'Elegir…' }),
      ...COUNTRIES.map(([v, t]) => el('option', { value: v, textContent: t })));
  });

  // El dorso no hace falta para pasaporte.
  const docType = form.elements.documentType;
  const backBox = form.querySelector('[data-for="documentBack"]');
  const syncBack = () => {
    const passport = docType.value === 'PASSPORT';
    backBox.classList.toggle('hidden', passport);
    form.elements.documentBack.required = !passport;
  };
  docType.addEventListener('change', syncBack);
  syncBack();

  // Vista previa de cada foto.
  form.querySelectorAll('.upload input[type=file]').forEach((input) => {
    input.addEventListener('change', () => {
      const box = input.closest('.upload');
      const img = box.querySelector('img');
      const file = input.files[0];
      box.classList.toggle('done', !!file);
      if (file && file.type.startsWith('image/')) {
        img.src = URL.createObjectURL(file);
        img.classList.remove('hidden');
      } else {
        img.classList.add('hidden');
      }
      box.querySelector('.up-hint').textContent = file ? `${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)` : 'Tocar para sacar foto';
    });
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = form.querySelector('#form-error');
    err.classList.add('hidden');
    if (!form.checkValidity()) {
      const bad = form.querySelector(':invalid');
      err.textContent = `Revisa el campo: ${bad.closest('label')?.childNodes[0]?.textContent?.trim() || bad.name}`;
      err.classList.remove('hidden');
      bad.focus();
      return;
    }
    const data = new FormData(form);
    data.delete('consent');
    if (docType.value === 'PASSPORT') data.delete('documentBack');
    for (const f of ['documentFront', 'documentBack', 'selfie']) {
      const file = data.get(f);
      if (file instanceof File && file.size > 5 * 1024 * 1024) {
        err.textContent = 'Cada foto debe pesar como máximo 5 MB';
        err.classList.remove('hidden');
        return;
      }
    }
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Enviando…';
    try {
      render(await api('POST', '/kyc/submissions', data));
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (ex) {
      err.textContent = ex.message;
      err.classList.remove('hidden');
      err.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } finally {
      btn.disabled = false;
      btn.textContent = 'Enviar verificación';
    }
  });
  return frag;
}

start().catch((e) => {
  root.replaceChildren(el('p', { className: 'alert', textContent: e.message }));
});
