// Configura el POS de demostración como comercio de la billetera:
//   1. crea (o reutiliza) el usuario dueño de la cafetería y verifica su correo con Mailpit,
//   2. el administrador registra el comercio con su URL de webhook (o rota la API key si ya existía),
//   3. guarda POS_API_KEY y POS_WEBHOOK_SECRET en .env.
// Requiere los servicios corriendo (npm run dev). Luego reinicia el POS.
import { readFileSync, writeFileSync } from 'node:fs';

const ENV_FILE = new URL('../.env', import.meta.url);
const envText = readFileSync(ENV_FILE, 'utf8');
const env = Object.fromEntries(
  envText.split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const API = process.env.POS_BILLETERA_API ?? env.POS_BILLETERA_API ?? 'http://localhost:4000/api';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const email = env.POS_MERCHANT_EMAIL ?? 'cafeteria.demo@billetera.local';
const password = env.POS_MERCHANT_PASSWORD ?? 'CafeDemo2026';
const storeName = env.POS_STORE_NAME ?? 'Cafetería Demo';
const webhookUrl = process.env.POS_WEBHOOK_URL ?? `http://localhost:${env.POS_PORT ?? 5000}/webhooks/billetera`;

async function call(method, path, body, token) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

async function codeFor(subject, after) {
  for (let i = 0; i < 30; i++) {
    const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`);
    const { messages } = await res.json();
    const msg = messages.find((m) => m.Subject.includes(subject) && new Date(m.Created) >= after);
    if (msg) return msg.Subject.slice(0, 6);
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`No llegó el correo "${subject}" a ${email} (¿Mailpit está corriendo?)`);
}

async function session() {
  const since = new Date(Date.now() - 2000);
  const reg = await call('POST', '/auth/register', { email, password, fullName: storeName });
  if (reg.status === 201) {
    const r = await call('POST', '/auth/verify-email', { email, code: await codeFor('Verifica tu correo', since) });
    console.log(`Usuario comercio creado: ${email}`);
    return r.data.accessToken;
  }
  const login = await call('POST', '/auth/login', { email, password });
  if (login.status !== 200) throw new Error(`No se pudo iniciar sesión como ${email}: ${login.data?.message}`);
  console.log(`Sesión iniciada como ${email}`);
  return login.data.accessToken;
}

function setEnv(text, key, value) {
  const re = new RegExp(`^${key}=.*$`, 'm');
  return re.test(text) ? text.replace(re, `${key}=${value}`) : `${text.trimEnd()}\n${key}=${value}\n`;
}

const token = await session();
const adminLogin = await call('POST', '/auth/login', { email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD });
if (adminLogin.status !== 200) throw new Error(`No se pudo iniciar sesión como admin: ${adminLogin.data?.message}`);
const adminToken = adminLogin.data.accessToken;
let merchant = await call('POST', '/payments/admin/merchants', { name: storeName, webhookUrl, ownerEmail: email }, adminToken);
if (merchant.status === 409) {
  const { id } = (await call('GET', '/payments/merchants/me', undefined, token)).data;
  await call('PATCH', `/payments/admin/merchants/${id}`, { name: storeName, webhookUrl }, adminToken);
  merchant = await call('POST', `/payments/admin/merchants/${id}/rotate-key`, undefined, adminToken);
  console.log('El comercio ya existía: se generó una API key nueva');
} else if (merchant.status !== 201) {
  throw new Error(`No se pudo crear el comercio: ${JSON.stringify(merchant.data)}`);
} else {
  console.log(`Comercio "${storeName}" registrado`);
}

let text = setEnv(envText, 'POS_API_KEY', merchant.data.apiKey);
text = setEnv(text, 'POS_WEBHOOK_SECRET', merchant.data.webhookSecret);
writeFileSync(ENV_FILE, text);

// Cliente de demostración para pagar desde la página /pay (credenciales en .env: DEMO_CUSTOMER_*).
const customer = {
  email: env.DEMO_CUSTOMER_EMAIL ?? 'cliente.demo@billetera.local',
  password: env.DEMO_CUSTOMER_PASSWORD ?? 'ClienteDemo2026',
  pin: env.DEMO_CUSTOMER_PIN ?? '2468',
};
const since = new Date(Date.now() - 2000);
const reg = await call('POST', '/auth/register', { email: customer.email, password: customer.password, fullName: 'Cliente Demo' });
if (reg.status === 201) {
  const mailTo = customer.email;
  let code;
  for (let i = 0; i < 30 && !code; i++) {
    const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${mailTo}"`)}`);
    const { messages } = await res.json();
    code = messages.find((m) => m.Subject.includes('Verifica tu correo') && new Date(m.Created) >= since)?.Subject.slice(0, 6);
    if (!code) await new Promise((r) => setTimeout(r, 500));
  }
  const s = await call('POST', '/auth/verify-email', { email: customer.email, code });
  await call('POST', '/auth/pin', { pin: customer.pin, password: customer.password }, s.data.accessToken);
  await call('POST', '/wallet/topups', { currency: 'USD', amount: '200.00' }, s.data.accessToken);
  await call('POST', '/wallet/topups', { currency: 'BOB', amount: '1000.00' }, s.data.accessToken);
  console.log(`Cliente demo creado: ${customer.email} con 200 USD y 1000 BOB (contraseña y PIN en .env)`);
} else {
  console.log(`Cliente demo ya existía: ${customer.email}`);
}
console.log(`Webhook: ${webhookUrl}`);
console.log(`API key ${merchant.data.apiKeyPrefix} guardada en .env (POS_API_KEY, POS_WEBHOOK_SECRET).`);
console.log('Listo. Reinicia el POS (npm run dev) y abre http://localhost:' + (env.POS_PORT ?? 5000));
