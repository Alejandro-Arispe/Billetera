// Página de pago QR de la billetera. Se abre al escanear el QR del POS con la cámara del celular.
// Flujo: (login + código por correo) -> leer QR -> elegir cuenta -> PIN -> pagado.
const API = '/api';
const SESSION_KEY = 'billetera.session';
const $ = (id) => document.getElementById(id);
const VIEWS = ['login', 'otp', 'scan', 'confirm', 'done'];

let challengeId = null;
let currentQr = null;
let intent = null;
let timer = null;
let scanner = null;

// ------------------------------------------------------------ sesión
function session() {
  try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch { return null; }
}
function saveSession(s) {
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch { /* modo privado */ }
}
function clearSession() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch { /* nada */ }
}

async function api(method, path, body) {
  const s = session();
  const res = await fetch(API + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(s?.accessToken ? { Authorization: `Bearer ${s.accessToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && s?.accessToken && path !== '/payments/qr/' + intent?.intentId + '/pay') {
    clearSession();
    show('login');
    throw new Error('Tu sesión expiró. Vuelve a iniciar sesión.');
  }
  if (!res.ok) throw new Error(Array.isArray(data.message) ? data.message.join('. ') : data.message || 'Error');
  return data;
}

// ------------------------------------------------------------ UI
function show(view) {
  VIEWS.forEach((v) => $(`view-${v}`).classList.toggle('hidden', v !== view));
  $('logout').classList.toggle('hidden', !session());
  if (view !== 'confirm') clearInterval(timer);
}
function showError(msg) {
  $('error').textContent = msg;
  $('error').classList.toggle('hidden', !msg);
}
function busy(form, on) {
  form.querySelectorAll('button').forEach((b) => (b.disabled = on));
}
async function run(form, fn) {
  showError('');
  busy(form, true);
  try { await fn(); } catch (e) { showError(e.message); } finally { busy(form, false); }
}
const money = (amount, currency) => `${currency} ${Number(amount).toLocaleString('es', { minimumFractionDigits: 2 })}`;

// ------------------------------------------------------------ login
$('form-login').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  run(e.target, async () => {
    const r = await api('POST', '/auth/login', { email: f.get('email'), password: f.get('password') });
    challengeId = r.challengeId;
    $('otp-msg').textContent = r.message;
    show('otp');
    e.target.reset();
  });
});

$('form-otp').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = new FormData(e.target).get('code');
  run(e.target, async () => {
    const tokens = await api('POST', '/auth/login/verify', { challengeId, code });
    saveSession(tokens);
    e.target.reset();
    await next();
  });
});

$('logout').addEventListener('click', () => {
  clearSession();
  show('login');
});

// ------------------------------------------------------------ escanear
$('form-paste').addEventListener('submit', (e) => {
  e.preventDefault();
  currentQr = new FormData(e.target).get('qr').trim();
  run(e.target, openIntent);
});

$('start-camera').addEventListener('click', async () => {
  showError('');
  if (!window.Html5Qrcode) return showError('No se pudo cargar el lector de QR');
  try {
    scanner = new Html5Qrcode('reader');
    await scanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: 240 }, async (text) => {
      await scanner.stop();
      currentQr = text;
      openIntent().catch((err) => showError(err.message));
    });
  } catch {
    showError('No se pudo abrir la cámara. En el celular usa la app de cámara para leer el QR.');
  }
});

// ------------------------------------------------------------ confirmar y pagar
async function openIntent() {
  intent = await api('POST', '/payments/qr/scan', { qr: currentQr });
  $('c-merchant').textContent = intent.merchant.name;
  $('c-amount').textContent = money(intent.amount, intent.currency);
  $('c-desc').textContent = intent.description;
  $('c-items').replaceChildren(
    ...intent.items.map((it) => {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = `${it.quantity} × ${it.name}`;
      const price = document.createElement('span');
      price.textContent = (Number(it.unitPrice) * it.quantity).toFixed(2);
      li.append(name, price);
      return li;
    }),
  );

  const options = intent.fundingOptions;
  const preferred = options.find((o) => o.currency === intent.currency && o.sufficient) ?? options.find((o) => o.sufficient);
  $('c-funding').replaceChildren(
    ...options.map((o) => {
      const label = document.createElement('label');
      label.className = 'option' + (o.sufficient ? '' : ' disabled');
      const left = document.createElement('span');
      const radio = document.createElement('input');
      Object.assign(radio, { type: 'radio', name: 'funding', value: o.currency, disabled: !o.sufficient });
      radio.checked = o === preferred;
      const strong = document.createElement('strong');
      strong.textContent = `${o.currency} ${o.debit}`;
      left.append(radio, strong);
      const right = document.createElement('span');
      right.className = 'right';
      right.textContent = `Saldo ${o.balance}` + (o.sufficient ? '' : ' · insuficiente');
      label.append(left, right);
      return label;
    }),
  );
  $('pay-btn').disabled = !preferred;
  if (!preferred) showError('No tienes saldo suficiente en ninguna cuenta.');

  clearInterval(timer);
  const tick = () => {
    const s = Math.max(0, Math.round((new Date(intent.expiresAt) - Date.now()) / 1000));
    $('c-timer').textContent = s > 0 ? `El QR vence en ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : 'El QR venció';
    if (s === 0) $('pay-btn').disabled = true;
  };
  tick();
  timer = setInterval(tick, 1000);
  show('confirm');
}

$('form-pay').addEventListener('submit', (e) => {
  e.preventDefault();
  const pin = new FormData(e.target).get('pin');
  const funding = document.querySelector('input[name=funding]:checked')?.value;
  run(e.target, async () => {
    const r = await api('POST', `/payments/qr/${intent.intentId}/pay`, { pin, fundingCurrency: funding });
    e.target.reset();
    $('d-amount').textContent = money(r.amount, r.currency);
    $('d-merchant').textContent = `a ${r.merchant.name}`;
    $('d-debited').textContent =
      r.debitedCurrency !== r.currency ? `Se debitaron ${money(r.debited, r.debitedCurrency)} (tasa ${Number(r.rate).toFixed(4)})` : '';
    $('d-tx').textContent = `Transacción ${r.transactionId}`;
    history.replaceState(null, '', '/pay');
    show('done');
  });
});

$('again').addEventListener('click', () => {
  currentQr = null;
  show('scan');
});

// ------------------------------------------------------------ arranque
async function next() {
  if (!session()) return show('login');
  if (currentQr) {
    try { await openIntent(); } catch (e) { showError(e.message); show('scan'); }
  } else {
    show('scan');
  }
}

const params = new URLSearchParams(location.search);
if (params.get('i') && params.get('s')) currentQr = location.href;
next();
