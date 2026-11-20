// Prueba de punta a punta de la Etapa 2: wallet multimoneda, P2P, cambio de divisas y tarjeta virtual.
// Requiere `npm run infra:up` y `npm run dev`.   Uso: npm run smoke:wallet
import { readFileSync } from 'node:fs';
import { verifyIdentity } from './lib.mjs';

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const API = process.env.API_URL ?? 'http://localhost:4000/api';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const WALLET_INTERNAL = `http://localhost:${env.WALLET_PORT ?? 3002}`;
const POS_KEY = (env.CARD_ACQUIRER_API_KEYS ?? 'demo-pos-key').split(',')[0];

async function call(method, path, { body, token, headers = {} } = {}) {
  const res = await fetch(path.startsWith('http') ? path : `${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
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
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`No llegó el código a ${to}`);
}

async function newUser(name) {
  const email = `${name.split(' ')[0].toLowerCase()}+${Date.now()}@billetera.local`;
  const password = 'Clave$egura123';
  // El registro tiene un límite de 5 por minuto: si lo alcanzamos, esperamos y reintentamos.
  for (let i = 0; ; i++) {
    const reg = await call('POST', '/auth/register', { body: { email, password, fullName: name } });
    if (reg.status !== 429 || i >= 8) break;
    console.log('  … límite de registros por minuto alcanzado, esperando 10 s');
    await new Promise((res) => setTimeout(res, 10_000));
  }
  const r = await call('POST', '/auth/verify-email', { body: { email, code: await codeFor(email) } });
  return { email, password, token: r.data.accessToken };
}

const balance = async (u, cur) =>
  (await call('GET', '/wallet/accounts', { token: u.token })).data.find((a) => a.currency === cur).balance;

console.log('\n== Usuarios ==');
const ana = await newUser('Ana Pérez');
const beto = await newUser('Beto Gómez');
expect(ana.token && beto.token, 'Ana y Beto registrados y con sesión');

let r = await call('GET', '/wallet/accounts', { token: ana.token });
expect(r.status === 200 && r.data.length === 3 && r.data.every((a) => a.balance === '0.00'),
  'cuentas USD/EUR/ARS creadas en 0.00', r.data);

console.log('\n== Tarjeta antes de cumplir requisitos ==');
r = await call('GET', '/cards/eligibility', { token: ana.token });
expect(r.status === 200 && r.data.eligible === false, 'sin PIN no es elegible', r.data);
r = await call('POST', '/cards', { token: ana.token, body: { pin: '4821' } });
expect(r.status === 403 && r.data.code === 'NOT_ELIGIBLE', 'no deja habilitar la tarjeta sin PIN', r.data);

await call('POST', '/auth/pin', { token: ana.token, body: { pin: '4821', password: ana.password } });
await call('POST', '/auth/pin', { token: beto.token, body: { pin: '7395', password: beto.password } });

console.log('\n== Recargas ==');
r = await call('POST', '/wallet/topups', { token: ana.token, body: { currency: 'USD', amount: '100.00' } });
expect(r.status === 201 && r.data.movements[0].balanceAfter === '100.00', 'recarga de 100 USD', r.data);
r = await call('POST', '/wallet/topups', { token: ana.token, body: { currency: 'USD', amount: '999999' } });
expect(r.status === 400, 'rechaza recarga sobre el máximo', r.data);
r = await call('POST', '/wallet/topups', { token: ana.token, body: { currency: 'USD', amount: 10.5 } });
expect(r.status === 400, 'rechaza montos numéricos (deben ser texto)', r.data);

console.log('\n== Envíos P2P ==');
const p2p = { toEmail: beto.email, currency: 'USD', amount: '25.00', description: 'Pizza', pin: '0000' };
r = await call('POST', '/wallet/transfers', { token: ana.token, body: p2p });
expect(r.status === 401, 'PIN incorrecto bloquea el envío', r.data);
const idem = `envio-${Date.now()}`;
r = await call('POST', '/wallet/transfers', { token: ana.token, body: { ...p2p, pin: '4821' }, headers: { 'Idempotency-Key': idem } });
expect(r.status === 201 && r.data.counterparty === 'Beto Gómez', 'Ana envía 25 USD a Beto', r.data);
const firstTx = r.data.transactionId;
r = await call('POST', '/wallet/transfers', { token: ana.token, body: { ...p2p, pin: '4821' }, headers: { 'Idempotency-Key': idem } });
expect(r.data.transactionId === firstTx, 'reintento con la misma Idempotency-Key no duplica', r.data);
expect((await balance(ana, 'USD')) === '75.00' && (await balance(beto, 'USD')) === '25.00', 'saldos: Ana 75, Beto 25');
r = await call('POST', '/wallet/transfers', { token: ana.token, body: { ...p2p, amount: '1000.00', pin: '4821' } });
expect(r.status === 422 && r.data.code === 'INSUFFICIENT_FUNDS', 'saldo insuficiente', r.data);
r = await call('POST', '/wallet/transfers', { token: ana.token, body: { ...p2p, toEmail: ana.email, pin: '4821' } });
expect(r.status === 400, 'no se puede enviar a uno mismo', r.data);

console.log('\n== Cambio de divisas ==');
r = await call('GET', '/wallet/fx/rates', { token: ana.token });
const usdArs = r.data.pairs.find((p) => p.from === 'USD' && p.to === 'ARS');
expect(r.status === 200 && usdArs.customer < usdArs.mid, `tasas (${r.data.source}): 1 USD = ${usdArs.mid} ARS, cliente ${usdArs.customer}`, r.data);
r = await call('POST', '/wallet/fx/quotes', { token: ana.token, body: { from: 'USD', to: 'ARS', amount: '10.00' } });
expect(r.status === 201 && r.data.quoteId, `cotización: 10 USD -> ${r.data.amountTo} ARS`, r.data);
const quoteId = r.data.quoteId;
r = await call('POST', '/wallet/fx/convert', { token: ana.token, body: { quoteId } });
expect(r.status === 200 && r.data.type === 'FX_CONVERSION', 'conversión ejecutada', r.data);
r = await call('POST', '/wallet/fx/convert', { token: ana.token, body: { quoteId } });
expect(r.status === 400, 'la cotización no se puede usar dos veces', r.data);
expect((await balance(ana, 'USD')) === '65.00' && (await balance(ana, 'ARS')) !== '0.00', 'saldos tras el cambio: 65 USD + ARS');

console.log('\n== Apartado Tarjetas ==');
r = await call('GET', '/cards/eligibility', { token: ana.token });
const idReq = r.data.requirements?.find((x) => x.key === 'IDENTITY_VERIFIED');
expect(r.data.eligible === false && idReq?.required && !idReq.done, 'con PIN pero sin identidad verificada aún no es elegible', r.data);
await verifyIdentity(ana, 'Ana', 'Pérez');
r = await call('GET', '/cards/eligibility', { token: ana.token });
expect(r.data.eligible === true, 'identidad verificada (KYC aprobado): ahora es elegible', r.data.requirements);
r = await call('POST', '/cards', { token: ana.token, body: { pin: '4821' } });
expect(r.status === 201 && r.data.status === 'ACTIVE' && r.data.holderName === 'ANA PEREZ',
  `tarjeta habilitada: ${r.data.maskedNumber} vence ${r.data.expiry}`, r.data);
const cardId = r.data.id;
r = await call('POST', '/cards', { token: ana.token, body: { pin: '4821' } });
expect(r.status === 403, 'no permite una segunda tarjeta activa', r.data);

r = await call('POST', `/cards/${cardId}/details`, { token: ana.token, body: { pin: '1111' } });
expect(r.status === 401, 'ver datos con PIN incorrecto falla', r.data);
r = await call('POST', `/cards/${cardId}/details`, { token: ana.token, body: { pin: '4821' } });
expect(r.status === 200 && /^\d{4} \d{4} \d{4} \d{4}$/.test(r.data.number) && /^\d{3}$/.test(r.data.cvv),
  `datos para rellenar: ${r.data.number} · ${r.data.expiry} · CVV ${r.data.cvv}`, r.data);
const card = r.data;
r = await call('POST', `/cards/${cardId}/details`, { token: beto.token, body: { pin: '7395' } });
expect(r.status === 404, 'Beto no puede ver la tarjeta de Ana', r.data);

console.log('\n== Compras con la tarjeta (checkout del comercio) ==');
const form = {
  cardNumber: card.number,
  expMonth: card.expMonth,
  expYear: card.expYear % 100,
  cvv: card.cvv,
  holderName: card.holderName,
  merchantName: 'Cafetería Central',
};
const pos = (body, key = POS_KEY) =>
  call('POST', '/cards/authorizations', { body, headers: key ? { 'x-api-key': key } : {} });

r = await pos({ ...form, amount: '15.90', currency: 'USD', reference: 'ORD-1' }, null);
expect(r.status === 401, 'sin API key de comercio no se puede cobrar', r.data);
r = await pos({ ...form, amount: '15.90', currency: 'USD', reference: 'ORD-1' });
expect(r.data.status === 'APPROVED' && r.data.approvalCode, `compra aprobada (código ${r.data.approvalCode})`, r.data);
const authId = r.data.authorizationId;
r = await pos({ ...form, amount: '15.90', currency: 'USD', reference: 'ORD-1' });
expect(r.data.authorizationId === authId, 'reintento del comercio no cobra dos veces', r.data);
expect((await balance(ana, 'USD')) === '49.10', 'saldo USD: 65 - 15.90 = 49.10');

r = await pos({ ...form, cvv: card.cvv === '999' ? '998' : '999', amount: '5.00', currency: 'USD', reference: 'ORD-2' });
expect(r.data.declineCode === 'INVALID_CVV', 'CVV incorrecto rechazado', r.data);
r = await pos({ ...form, expMonth: (card.expMonth % 12) + 1, amount: '5.00', currency: 'USD', reference: 'ORD-3' });
expect(r.data.declineCode === 'EXPIRED_CARD', 'vencimiento incorrecto rechazado', r.data);
r = await pos({ ...form, cardNumber: '4000001200000000', amount: '5.00', currency: 'USD', reference: 'ORD-4' });
expect(r.data.declineCode === 'INVALID_CARD', 'número inexistente rechazado', r.data);

r = await pos({ ...form, amount: '10.00', currency: 'EUR', reference: 'ORD-5' });
expect(r.data.status === 'APPROVED' && r.data.debitedCurrency === 'USD',
  `compra en EUR: 10.00 EUR debitó ${r.data.debited} USD`, r.data);

await call('POST', `/cards/${cardId}/freeze`, { token: ana.token });
r = await pos({ ...form, amount: '1.00', currency: 'USD', reference: 'ORD-6' });
expect(r.data.declineCode === 'CARD_FROZEN', 'tarjeta pausada rechaza compras', r.data);
r = await call('POST', `/cards/${cardId}/unfreeze`, { token: ana.token });
expect(r.data.status === 'ACTIVE', 'tarjeta reactivada', r.data);

r = await call('PATCH', `/cards/${cardId}/limit`, { token: ana.token, body: { monthlyLimit: '30.00' } });
expect(r.status === 200 && r.data.monthlyLimit === '30.00', `límite 30.00 (gastado ${r.data.spentThisMonth})`, r.data);
r = await pos({ ...form, amount: '10.00', currency: 'USD', reference: 'ORD-7' });
expect(r.data.declineCode === 'LIMIT_EXCEEDED', 'supera el límite mensual', r.data);
await call('PATCH', `/cards/${cardId}/limit`, { token: ana.token, body: { monthlyLimit: '10000.00' } });
r = await pos({ ...form, amount: '500.00', currency: 'USD', reference: 'ORD-8' });
expect(r.data.declineCode === 'INSUFFICIENT_FUNDS', 'fondos insuficientes', r.data);

r = await call('GET', `/cards/${cardId}/transactions`, { token: ana.token });
expect(r.data.length === 7, `${r.data.length} intentos registrados (2 aprobados, 5 rechazados)`, r.data);

console.log('\n== Historial y auditoría ==');
r = await call('GET', '/wallet/transactions', { token: ana.token });
const types = r.data.items.map((i) => i.type);
expect(['TOPUP', 'P2P_TRANSFER', 'FX_CONVERSION', 'CARD_PAYMENT'].every((t) => types.includes(t)),
  `historial de Ana: ${r.data.total} movimientos`, r.data.items);
r = await call('GET', '/wallet/transactions', { token: beto.token });
expect(r.data.items[0].counterparty === 'Ana Pérez' && r.data.items[0].direction === 'IN', 'Beto ve el envío de Ana', r.data);

console.log('\n== Concurrencia ==');
// Beto tiene 25 USD y dispara 10 envíos de 5 USD a la vez: solo 5 pueden pasar.
const burst = await Promise.all(
  Array.from({ length: 10 }, () =>
    call('POST', '/wallet/transfers', {
      token: beto.token,
      body: { toEmail: ana.email, currency: 'USD', amount: '5.00', pin: '7395' },
    }),
  ),
);
const okCount = burst.filter((x) => x.status === 201).length;
const rejected = burst.filter((x) => x.status === 422).length;
expect(okCount === 5 && rejected === 5 && (await balance(beto, 'USD')) === '0.00',
  `10 envíos simultáneos: ${okCount} aprobados, ${rejected} sin fondos, saldo final 0.00`, burst.map((b) => b.status));

r = await call('GET', `${WALLET_INTERNAL}/internal/wallet/audit`);
expect(r.status === 401, 'la API interna exige clave', r.data);
r = await call('GET', `${WALLET_INTERNAL}/internal/wallet/audit`, { headers: { 'x-internal-key': env.INTERNAL_API_KEY } });
expect(r.data.balanced === true, 'el ledger cuadra: suma 0 por moneda y saldos = asientos', r.data);

console.log('\nEtapa 2 funciona de punta a punta ✔');
