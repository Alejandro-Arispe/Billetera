// Prueba de punta a punta de la Etapa 3: comercios, cobros QR, pago desde la billetera,
// webhooks firmados y el POS de demostración.
// Requiere `npm run infra:up`, `npm run dev` y (para la parte del POS) `npm run pos:setup`.
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { verifyIdentity } from './lib.mjs';

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const API = process.env.API_URL ?? 'http://localhost:4000/api';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const POS = `http://localhost:${env.POS_PORT ?? 5000}`;
const HOOK_PORT = 5099;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, { body, token, key, headers = {} } = {}) {
  const res = await fetch(path.startsWith('http') ? path : `${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(key ? { 'x-api-key': key } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

function expect(cond, msg, extra) {
  if (!cond) {
    console.error(`  FALLA: ${msg}`);
    if (extra !== undefined) console.error(JSON.stringify(extra, null, 2));
    hookServer.close();
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

async function codeFor(to) {
  for (let i = 0; i < 20; i++) {
    const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
    const { messages } = await res.json();
    const msg = messages.find((m) => m.Subject.includes('Verifica tu correo'));
    if (msg) return msg.Subject.slice(0, 6);
    await sleep(500);
  }
  throw new Error(`No llegó el código a ${to}`);
}

async function newUser(name, pin) {
  const slug = name.split(' ')[0].normalize('NFD').replace(/[^a-zA-Z]/g, '').toLowerCase();
  const email = `${slug}+${Date.now()}@billetera.local`;
  const password = 'Clave$egura123';
  // El registro tiene un límite de 5 por minuto: si lo alcanzamos, esperamos y reintentamos.
  for (let i = 0; ; i++) {
    const reg = await call('POST', '/auth/register', { body: { email, password, fullName: name } });
    if (reg.status !== 429 || i >= 8) break;
    console.log('  … límite de registros por minuto alcanzado, esperando 10 s');
    await new Promise((res) => setTimeout(res, 10_000));
  }
  const r = await call('POST', '/auth/verify-email', { body: { email, code: await codeFor(email) } });
  await call('POST', '/auth/pin', { token: r.data.accessToken, body: { pin, password } });
  return { email, password, pin, token: r.data.accessToken };
}

const balance = async (u, cur) =>
  (await call('GET', '/wallet/accounts', { token: u.token })).data.find((a) => a.currency === cur).balance;

// ------------------------------------------------------------ receptor de webhooks de prueba
let webhookSecret = '';
const hooks = [];
const hookServer = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const sig = Object.fromEntries((req.headers['billetera-signature'] ?? '').split(',').map((kv) => kv.split('=')));
    const expected = createHmac('sha256', webhookSecret).update(`${sig.t}.${raw}`).digest('hex');
    hooks.push({ event: JSON.parse(raw), valid: sig.v1 === expected });
    res.writeHead(200).end('ok');
  });
}).listen(HOOK_PORT);

async function waitHook(type, intentId) {
  for (let i = 0; i < 40; i++) {
    const h = hooks.find((x) => x.event.type === type && x.event.data.object.id === intentId);
    if (h) return h;
    await sleep(250);
  }
  return null;
}

// ============================================================ API de cobros
console.log('\n== Comercio ==');
const shop = await newUser('Panadería Sol', '6402');
const ana = await newUser('Ana Pérez', '4821');
let r = await call('POST', '/payments/merchants', {
  token: shop.token,
  body: { name: 'Panadería Sol', webhookUrl: `http://localhost:${HOOK_PORT}/hook` },
});
expect(r.status === 201 && r.data.apiKey.startsWith('sk_test_'), `comercio registrado (${r.data.apiKeyPrefix})`, r.data);
const KEY = r.data.apiKey;
webhookSecret = r.data.webhookSecret;
r = await call('POST', '/payments/merchants', { token: shop.token, body: { name: 'Otra' } });
expect(r.status === 409, 'un usuario solo puede tener un comercio', r.data);

console.log('\n== Crear cobro (lado POS) ==');
const items = [
  { name: 'Pan de campo', quantity: 2, unitPrice: '2.25' },
  { name: 'Café', quantity: 1, unitPrice: '2.50' },
];
const ref = `ORD-${Date.now()}`;
r = await call('POST', '/payments/intents', { body: { amount: '7.00', currency: 'USD', reference: ref, items } });
expect(r.status === 401, 'sin API key no se puede cobrar', r.data);
r = await call('POST', '/payments/intents', { key: 'sk_test_falsa', body: { amount: '7.00', currency: 'USD', reference: ref } });
expect(r.status === 401, 'API key falsa rechazada', r.data);
r = await call('POST', '/payments/intents', { key: KEY, body: { amount: '9.99', currency: 'USD', reference: ref, items } });
expect(r.status === 400, 'rechaza si los productos no suman el monto', r.data);
r = await call('POST', '/payments/intents', { key: KEY, body: { amount: '7.00', currency: 'USD', reference: ref, items } });
expect(r.status === 201 && r.data.status === 'CREATED' && r.data.qr.image.startsWith('data:image/png'),
  `cobro creado con QR: ${r.data.qr.payload}`, r.data);
const intent = r.data;
r = await call('POST', '/payments/intents', { key: KEY, body: { amount: '7.00', currency: 'USD', reference: ref, items } });
expect(r.data.id === intent.id, 'misma referencia devuelve el mismo cobro (reintento del POS)', r.data);
r = await call('POST', '/payments/intents', { key: KEY, body: { amount: '8.00', currency: 'USD', reference: ref } });
expect(r.status === 409, 'misma referencia con otro monto es un conflicto', r.data);

console.log('\n== Escanear y pagar (lado cliente) ==');
await call('POST', '/wallet/topups', { token: ana.token, body: { currency: 'USD', amount: '20.00' } });
const tampered = intent.qr.payload.replace(/s=.{4}/, 's=XXXX');
r = await call('POST', '/payments/qr/scan', { token: ana.token, body: { qr: tampered } });
expect(r.status === 400, 'QR alterado es rechazado', r.data);
r = await call('POST', '/payments/qr/scan', { token: shop.token, body: { qr: intent.qr.payload } });
expect(r.status === 403, 'el comercio no puede pagarse a sí mismo', r.data);
r = await call('POST', '/payments/qr/scan', { token: ana.token, body: { qr: intent.qr.payload } });
const usdOpt = r.data.fundingOptions?.find((o) => o.currency === 'USD');
const eurOpt = r.data.fundingOptions?.find((o) => o.currency === 'EUR');
expect(r.status === 200 && r.data.status === 'SCANNED' && r.data.merchant.name === 'Panadería Sol' && usdOpt.sufficient && !eurOpt.sufficient,
  `escaneo: pagar ${r.data.amount} ${r.data.currency} a ${r.data.merchant.name} (USD alcanza, EUR no)`, r.data);
let hook = await waitHook('payment_intent.scanned', intent.id);
expect(hook?.valid, 'webhook "scanned" llegó con firma válida', hooks.map((h) => h.event.type));

r = await call('POST', `/payments/qr/${intent.id}/pay`, { token: ana.token, body: { pin: '0000' } });
expect(r.status === 401, 'PIN incorrecto no paga', r.data);
r = await call('GET', `/payments/intents/${intent.id}`, { key: KEY });
expect(r.data.status === 'SCANNED', 'tras el PIN incorrecto el cobro sigue pendiente', r.data.status);

r = await call('POST', `/payments/qr/${intent.id}/pay`, { token: ana.token, body: { pin: '4821' } });
expect(r.status === 200 && r.data.status === 'PAID' && r.data.debited === '7.00', `PAGADO: transacción ${r.data.transactionId}`, r.data);
r = await call('POST', `/payments/qr/${intent.id}/pay`, { token: ana.token, body: { pin: '4821' } });
expect(r.status === 409, 'no se puede pagar dos veces', r.data);
expect((await balance(ana, 'USD')) === '13.00' && (await balance(shop, 'USD')) === '7.00',
  'saldos: Ana 20 - 7 = 13 USD, el comercio recibió 7 USD');

hook = await waitHook('payment_intent.succeeded', intent.id);
expect(hook?.valid && hook.event.data.object.status === 'PAID' && hook.event.data.object.payer.name === 'Ana Pérez',
  'webhook "succeeded" firmado: PAID, pagado por Ana Pérez', hook);
r = await call('GET', `/payments/intents/${intent.id}`, { key: KEY });
expect(r.data.status === 'PAID' && !r.data.qr, 'consulta del POS: PAID (sin QR)', r.data);
r = await call('GET', `/payments/intents/${intent.id}/webhooks`, { key: KEY });
expect(r.data.length === 2 && r.data.every((d) => d.status === 'DELIVERED'), 'registro de webhooks: 2 entregados', r.data);

r = await call('GET', '/wallet/transactions', { token: shop.token });
expect(r.data.items[0].type === 'QR_PAYMENT' && r.data.items[0].counterparty === 'Ana Pérez' && r.data.items[0].direction === 'IN',
  'el comercio ve el cobro de Ana en su historial', r.data.items[0]);

console.log('\n== Cobro en otra moneda ==');
r = await call('POST', '/payments/intents', { key: KEY, body: { amount: '1000.00', currency: 'ARS', reference: `${ref}-ars` } });
const arsIntent = r.data;
r = await call('POST', '/payments/qr/scan', { token: ana.token, body: { qr: arsIntent.qr.payload } });
const usdForArs = r.data.fundingOptions.find((o) => o.currency === 'USD');
r = await call('POST', `/payments/qr/${arsIntent.id}/pay`, { token: ana.token, body: { pin: '4821', fundingCurrency: 'USD' } });
expect(r.status === 200 && r.data.debitedCurrency === 'USD' && r.data.debited === usdForArs.debit,
  `1000.00 ARS pagados con ${r.data.debited} USD (lo mismo que se le mostró)`, r.data);
expect((await balance(shop, 'ARS')) === '1000.00', 'el comercio recibió 1000.00 ARS');

console.log('\n== Cancelación, vencimiento y concurrencia ==');
r = await call('POST', '/payments/intents', { key: KEY, body: { amount: '3.00', currency: 'USD', reference: `${ref}-c` } });
const toCancel = r.data;
r = await call('POST', `/payments/intents/${toCancel.id}/cancel`, { key: KEY });
expect(r.data.status === 'CANCELLED', 'el POS cancela un cobro', r.data);
r = await call('POST', '/payments/qr/scan', { token: ana.token, body: { qr: toCancel.qr.payload } });
expect(r.status === 410, 'un QR cancelado ya no se puede pagar', r.data);
expect((await waitHook('payment_intent.canceled', toCancel.id))?.valid, 'webhook "canceled" recibido');

r = await call('POST', '/payments/intents', { key: KEY, body: { amount: '1.00', currency: 'USD', reference: `${ref}-race` } });
const race = r.data;
const tries = await Promise.all(
  Array.from({ length: 5 }, () => call('POST', `/payments/qr/${race.id}/pay`, { token: ana.token, body: { pin: '4821' } })),
);
const paid = tries.filter((t) => t.status === 200).length;
expect(paid === 1 && tries.filter((t) => t.status === 409).length === 4,
  `5 pagos simultáneos del mismo QR: ${paid} aprobado, 4 rechazados`, tries.map((t) => t.status));
expect((await balance(ana, 'USD')) === (13 - Number(usdForArs.debit) - 1).toFixed(2), 'se cobró una sola vez');

r = await call('POST', '/payments/intents', { key: KEY, body: { amount: '2.00', currency: 'USD', reference: `${ref}-exp`, expiresInSeconds: 15 } });
const exp = r.data;
console.log('  … esperando 20 s a que venza un QR de 15 s');
await sleep(20_000);
r = await call('GET', `/payments/intents/${exp.id}`, { key: KEY });
expect(r.data.status === 'EXPIRED', 'el QR venció solo', r.data.status);
expect((await waitHook('payment_intent.expired', exp.id))?.valid, 'webhook "expired" recibido');
r = await call('POST', '/payments/qr/scan', { token: ana.token, body: { qr: exp.qr.payload } });
expect(r.status === 410, 'un QR vencido no se puede pagar', r.data);

r = await call('GET', `http://localhost:${env.WALLET_PORT ?? 3002}/internal/wallet/audit`, {
  headers: { 'x-internal-key': env.INTERNAL_API_KEY },
});
expect(r.data.balanced === true, 'el ledger sigue cuadrando', r.data);

r = await fetch(new URL(intent.qr.payload));
expect(r.status === 200 && (await r.text()).includes('Pagar con Billetera'), 'la URL del QR abre la página de pago');

// ============================================================ POS de demostración
console.log('\n== POS de demostración ==');
let cfg;
try {
  cfg = await call('GET', `${POS}/api/config`);
} catch {
  cfg = null;
}
if (!cfg?.data?.configured) {
  console.log('  (omitido: el POS no está corriendo o falta "npm run pos:setup")');
} else {
  r = await call('POST', `${POS}/api/orders`, { body: { items: [{ productId: 'latte', quantity: 2 }, { productId: 'medialuna', quantity: 1 }] } });
  expect(r.data.total === '8.20', `orden #${r.data.number}: 2 latte + 1 medialuna = 8.20`, r.data);
  const order = r.data;
  r = await call('POST', `${POS}/api/orders/${order.id}/qr`);
  expect(r.data.status === 'WAITING_PAYMENT' && r.data.qrImage, 'el POS muestra el QR', r.data.status);
  const bob = await newUser('Beto Gómez', '7395');
  await call('POST', '/wallet/topups', { token: bob.token, body: { currency: 'USD', amount: '50.00' } });
  r = await call('POST', '/payments/qr/scan', { token: bob.token, body: { qr: r.data.qrPayload } });
  r = await call('POST', `/payments/qr/${r.data.intentId}/pay`, { token: bob.token, body: { pin: '7395' } });
  expect(r.data.status === 'PAID', 'Beto paga el QR del POS desde su billetera', r.data);
  let st;
  for (let i = 0; i < 20; i++) {
    st = (await call('GET', `${POS}/api/orders/${order.id}`)).data;
    if (st.status === 'PAID') break;
    await sleep(250);
  }
  expect(st.status === 'PAID' && st.payerName === 'Beto Gómez', 'el POS marcó la orden como PAGADA (vía webhook)', st.events);

  // Pago con tarjeta virtual en la caja (la tarjeta exige identidad verificada)
  await verifyIdentity(bob, 'Beto', 'Gómez');
  await call('POST', '/cards', { token: bob.token, body: { pin: '7395' } });
  const cards = (await call('GET', '/cards', { token: bob.token })).data;
  const d = (await call('POST', `/cards/${cards[0].id}/details`, { token: bob.token, body: { pin: '7395' } })).data;
  r = await call('POST', `${POS}/api/orders`, { body: { items: [{ productId: 'sandwich', quantity: 1 }] } });
  const order2 = r.data;
  r = await call('POST', `${POS}/api/orders/${order2.id}/card`, {
    body: { cardNumber: d.number.replace(/\s/g, ''), expMonth: d.expMonth, expYear: d.expYear % 100, cvv: d.cvv },
  });
  expect(r.data.authorization.status === 'APPROVED' && r.data.order.status === 'PAID',
    `el POS cobró 5.90 con la tarjeta •••• ${d.number.slice(-4)}`, r.data);
  expect((await balance(bob, 'USD')) === '35.90', 'saldo de Beto: 50 - 8.20 - 5.90 = 35.90');
}

hookServer.close();
console.log('\nEtapa 3 funciona de punta a punta ✔');
