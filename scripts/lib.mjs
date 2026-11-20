// Utilidades compartidas por los scripts de prueba.
import { readFileSync } from 'node:fs';

export const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
export const API = process.env.API_URL ?? 'http://localhost:4000/api';
export const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** PNG de 1x1 válido: alcanza para pasar la validación de tipo de archivo. */
export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

export async function call(method, path, { body, token, headers = {} } = {}) {
  const isForm = body instanceof FormData;
  const res = await fetch(path.startsWith('http') ? path : `${API}${path}`, {
    method,
    headers: {
      ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: isForm ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

/** Último código de 6 dígitos enviado a `to` cuyo asunto contiene `subject`, posterior a `since`. */
export async function mailCode(to, subject, since = new Date(0)) {
  for (let i = 0; i < 40; i++) {
    const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
    const { messages } = await res.json();
    const msg = messages.find((m) => m.Subject.includes(subject) && new Date(m.Created) >= since);
    if (msg) return msg.Subject.slice(0, 6);
    await sleep(250);
  }
  throw new Error(`No llegó el correo "${subject}" a ${to}`);
}

export async function lastMailSubject(to, contains, since) {
  for (let i = 0; i < 40; i++) {
    const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
    const { messages } = await res.json();
    const msg = messages.find((m) => m.Subject.includes(contains) && new Date(m.Created) >= since);
    if (msg) return msg.Subject;
    await sleep(250);
  }
  return null;
}

/** Login completo (contraseña + código por correo). */
export async function loginWithOtp(email, password) {
  let since = new Date(Date.now() - 1000);
  let r = await call('POST', '/auth/login', { body: { email, password } });
  // Entre códigos de acceso hay que esperar 60 s (protección anti-spam): reintentamos.
  for (let i = 0; r.status === 429 && i < 8; i++) {
    console.log('  … esperando 10 s para pedir otro código de acceso');
    await sleep(10_000);
    since = new Date(Date.now() - 1000);
    r = await call('POST', '/auth/login', { body: { email, password } });
  }
  if (r.status !== 200) throw new Error(`Login de ${email} falló: ${JSON.stringify(r.data)}`);
  const v = await call('POST', '/auth/login/verify', {
    body: { challengeId: r.data.challengeId, code: await mailCode(email, 'Tu código de acceso', since) },
  });
  return v.data.accessToken;
}

let adminToken = null;
export async function admin() {
  adminToken ??= await loginWithOtp(env.ADMIN_EMAIL, env.ADMIN_PASSWORD);
  return adminToken;
}

/** Arma el formulario de verificación con datos válidos (sobrescribibles). */
export function kycForm(overrides = {}, files = {}) {
  const data = {
    firstName: 'Ana',
    lastName: 'Pérez',
    birthDate: '1998-04-21',
    nationality: 'AR',
    documentType: 'DNI',
    documentNumber: String(30_000_000 + Math.floor(Math.random() * 60_000_000)),
    documentExpiresAt: '2033-04-21',
    addressLine1: 'Av. Corrientes 1234',
    city: 'Buenos Aires',
    state: 'CABA',
    postalCode: 'C1043',
    country: 'AR',
    phone: '+5491155550000',
    occupation: 'Estudiante',
    ...overrides,
  };
  const form = new FormData();
  for (const [k, v] of Object.entries(data)) if (v !== undefined) form.append(k, v);
  const f = { documentFront: TINY_PNG, documentBack: TINY_PNG, selfie: TINY_PNG, ...files };
  for (const [k, buf] of Object.entries(f)) if (buf) form.append(k, new Blob([buf], { type: 'image/png' }), `${k}.png`);
  return { form, data };
}

/** Envía la verificación del usuario y la aprueba como administrador. */
export async function verifyIdentity(user, firstName, lastName) {
  const { form } = kycForm({ firstName, lastName });
  const sub = await call('POST', '/kyc/submissions', { token: user.token, body: form });
  if (sub.status !== 201) throw new Error(`KYC de ${user.email} falló: ${JSON.stringify(sub.data)}`);
  const a = await call('POST', `/kyc/admin/submissions/${sub.data.submission.id}/approve`, { token: await admin() });
  if (a.status !== 200) throw new Error(`No se pudo aprobar el KYC: ${JSON.stringify(a.data)}`);
}
