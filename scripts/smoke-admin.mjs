// Prueba de punta a punta de la Etapa 5: panel de administración, SDK de comercios y app PWA.
// Requiere `npm run infra:up`, `npm run dev`, `npm run pos:setup` y `npm run build` (app y SDK compilados).
import { createRequire } from 'node:module';
import { admin, call, env, loginUser, mailCode, sleep } from './lib.mjs';

const require = createRequire(import.meta.url);
const { Billetera, BilleteraError, signWebhook, verifyWebhook } = require('../packages/sdk/dist/index.js');
const GATEWAY = 'http://localhost:4000';

function expect(cond, msg, extra) {
  if (!cond) {
    console.error(`  FALLA: ${msg}`);
    if (extra !== undefined) console.error(JSON.stringify(extra, null, 2));
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

async function newUser(fullName, pin) {
  const slug = fullName.split(' ')[0].normalize('NFD').replace(/[^a-zA-Z]/g, '').toLowerCase();
  const email = `${slug}+${Date.now()}@billetera.local`;
  const password = 'Clave$egura123';
  for (let i = 0; ; i++) {
    const reg = await call('POST', '/auth/register', { body: { email, password, fullName } });
    if (reg.status !== 429 || i >= 8) break;
    console.log('  … límite de registros por minuto alcanzado, esperando 10 s');
    await sleep(10_000);
  }
  const r = await call('POST', '/auth/verify-email', { body: { email, code: await mailCode(email, 'Verifica tu correo') } });
  await call('POST', '/auth/pin', { token: r.data.accessToken, body: { pin, password } });
  return { email, password, token: r.data.accessToken };
}

console.log('\n== App PWA servida por el gateway ==');
let res = await fetch(`${GATEWAY}/`);
let html = await res.text();
expect(res.status === 200 && html.includes('<div id="root">') && html.includes('manifest.webmanifest'), 'GET / entrega la app');
res = await fetch(`${GATEWAY}/tarjeta`);
expect(res.status === 200 && (await res.text()).includes('<div id="root">'), 'las rutas internas (/tarjeta) también entregan la app');
const manifest = await (await fetch(`${GATEWAY}/manifest.webmanifest`)).json();
expect(manifest.display === 'standalone' && manifest.icons.some((i) => i.sizes === '512x512'), 'manifest instalable (standalone + ícono 512)');
res = await fetch(`${GATEWAY}/sw.js`);
expect(res.status === 200 && (await res.text()).includes('billetera-v1'), 'service worker publicado');
res = await fetch(`${GATEWAY}/icons/icon-512.png`);
expect(res.status === 200 && res.headers.get('content-type') === 'image/png', 'íconos publicados');
const asset = html.match(/\/assets\/[^"]+\.js/)?.[0];
res = await fetch(`${GATEWAY}${asset}`);
expect(res.status === 200 && /immutable/.test(res.headers.get('cache-control') ?? ''), `bundle ${asset} con caché larga`);
expect((await fetch(`${GATEWAY}/health`)).status === 200 && (await fetch(`${GATEWAY}/pay`)).status === 200 && (await fetch(`${GATEWAY}/api/auth/me`)).status === 401,
  '/health, /pay y /api siguen funcionando');

console.log('\n== Panel de administración ==');
const adminToken = await admin();
const elena = await newUser('Elena Vidal', '3691');
let r = await call('GET', '/auth/admin/stats', { token: elena.token });
expect(r.status === 403, 'un usuario común no accede a las APIs de admin', r.data);

r = await call('GET', '/auth/admin/stats', { token: adminToken });
expect(r.status === 200 && r.data.total > 0 && r.data.byRole.ADMIN >= 1, `estadísticas: ${r.data.total} usuarios, ${r.data.last24h} nuevos hoy`, r.data);
r = await call('GET', `/auth/admin/users?q=${encodeURIComponent(elena.email)}`, { token: adminToken });
expect(r.data.total === 1 && r.data.items[0].fullName === 'Elena Vidal', 'búsqueda de usuarios por correo', r.data);
const elenaId = r.data.items[0].id;

await call('POST', '/wallet/topups', { token: elena.token, body: { currency: 'USD', amount: '30.00' } });
r = await call('POST', `/auth/admin/users/${elenaId}/block`, { token: adminToken });
expect(r.status === 200 && r.data.status === 'BLOCKED', 'el admin bloquea a Elena', r.data);
r = await call('POST', '/auth/login', { body: { email: elena.email, password: elena.password } });
expect(r.status === 403 && /bloqueada/.test(r.data.message), 'bloqueada no puede ingresar', r.data);
r = await call('POST', '/wallet/transfers', {
  token: elena.token,
  body: { toEmail: env.DEMO_CUSTOMER_EMAIL, currency: 'USD', amount: '5.00', pin: '3691' },
});
expect(r.status === 403, 'con su token aún vigente tampoco puede mover dinero', r.data);
r = await call('POST', `/auth/admin/users/${elenaId}/unblock`, { token: adminToken });
expect(r.data.status === 'ACTIVE', 'el admin la desbloquea', r.data);
r = await call('POST', `/auth/admin/users/${elenaId}/block`, { token: elena.token });
expect(r.status === 403, 'un usuario no puede bloquear a otros', r.data);

r = await call('GET', '/wallet/admin/stats', { token: adminToken });
expect(r.status === 200 && r.data.ledger.balanced && r.data.userBalances.length === 3,
  `dinero de usuarios: ${r.data.userBalances.map((b) => `${b.currency} ${b.total}`).join(' · ')} (ledger cuadrado)`, r.data);
r = await call('GET', '/wallet/admin/transactions?type=TOPUP', { token: adminToken });
const sums = r.data[0]?.entries.reduce((s, e) => s + Number(e.amount), 0);
expect(r.data.length > 0 && r.data.every((t) => t.type === 'TOPUP') && Math.abs(sums) < 1e-9,
  'transacciones filtradas por tipo, con asientos que suman 0', r.data[0]);
r = await call('GET', '/payments/admin/merchants', { token: adminToken });
expect(r.status === 200 && r.data.items.some((m) => m.name === env.POS_STORE_NAME), `comercios: ${r.data.items.length} registrados`, r.data);

console.log('\n== SDK de comercios (@billetera/sdk) ==');
expect((() => {
  try {
    new Billetera({});
    return false;
  } catch {
    return true;
  }
})(), 'el SDK exige apiKey');
const sdk = new Billetera({ apiKey: env.POS_API_KEY, baseUrl: `${GATEWAY}/api` });
const ref = `SDK-${Date.now()}`;
const cobro = await sdk.payments.create({
  amount: '4.70',
  currency: 'USD',
  reference: ref,
  items: [{ name: 'Café americano', quantity: 1, unitPrice: '2.50' }, { name: 'Medialuna', quantity: 1, unitPrice: '2.20' }],
});
expect(cobro.status === 'CREATED' && cobro.qr.image.startsWith('data:image/png'), `payments.create → ${cobro.id}`);
try {
  await sdk.payments.create({ amount: '1.00', currency: 'USD', reference: ref });
  expect(false, 'debía fallar');
} catch (e) {
  expect(e instanceof BilleteraError && e.status === 409, `errores como BilleteraError (${e.status}: ${e.message})`);
}
try {
  await new Billetera({ apiKey: 'sk_test_x', baseUrl: 'http://localhost:1/api' }).payments.retrieve(cobro.id);
} catch (e) {
  expect(e instanceof BilleteraError && e.status === 0, 'sin conexión → BilleteraError con status 0');
}

// El cliente demo paga mientras el SDK espera el resultado.
const waiting = sdk.payments.waitForStatus(cobro.id, ['PAID'], { intervalMs: 500, timeoutMs: 30_000 });
const customerToken = await loginUser(env.DEMO_CUSTOMER_EMAIL, env.DEMO_CUSTOMER_PASSWORD);
const scan = await call('POST', '/payments/qr/scan', { token: customerToken, body: { qr: cobro.qr.payload } });
const pin = env.DEMO_CUSTOMER_PIN;
await call('POST', `/payments/qr/${scan.data.intentId}/pay`, { token: customerToken, body: { pin } });
const final = await waiting;
expect(final.status === 'PAID' && final.payer?.name, `payments.waitForStatus → PAID por ${final.payer?.name}`);
expect((await sdk.payments.list({ status: 'PAID' })).some((p) => p.id === cobro.id), 'payments.list filtra por estado');

const body = JSON.stringify({ id: 'evt_test', type: 'payment_intent.succeeded', createdAt: new Date().toISOString(), data: { object: final } });
const header = signWebhook(body, env.POS_WEBHOOK_SECRET);
expect(verifyWebhook(Buffer.from(body), header, env.POS_WEBHOOK_SECRET).data.object.id === cobro.id, 'verifyWebhook acepta una firma válida');
const reject = (fn) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};
expect(reject(() => verifyWebhook(body.replace('4.70', '0.01'), header, env.POS_WEBHOOK_SECRET)), 'rechaza un cuerpo alterado');
expect(reject(() => verifyWebhook(body, header, 'whsec_otro')), 'rechaza otro secreto');
expect(reject(() => verifyWebhook(body, signWebhook(body, env.POS_WEBHOOK_SECRET, Math.floor(Date.now() / 1000) - 3600), env.POS_WEBHOOK_SECRET)),
  'rechaza webhooks viejos (repetición)');

console.log('\nEtapa 5 funciona de punta a punta ✔');
