// Prueba de punta a punta del flujo de autenticación a través del API gateway.
// Lee los códigos OTP desde la API de Mailpit, así que requiere `npm run infra:up` y `npm run dev`.
//   npm run smoke
const API = process.env.API_URL ?? 'http://localhost:4000/api';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';

const email = `prueba+${Date.now()}@billetera.local`;
const password = 'Clave$egura123';

async function call(method, path, body, token) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  return { status: res.status, data };
}

function expect(cond, msg, extra) {
  if (!cond) {
    console.error(`  FALLA: ${msg}`, extra ?? '');
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

async function latestCode(to, subjectPart) {
  for (let i = 0; i < 20; i++) {
    const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
    const { messages } = await res.json();
    const msg = messages.find((m) => m.Subject.includes(subjectPart));
    if (msg) return msg.Subject.slice(0, 6);
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`No llegó el correo "${subjectPart}" a ${to}`);
}

console.log(`Usuario de prueba: ${email}`);

let r = await call('POST', '/auth/register', { email, password, fullName: 'Ana Prueba' });
// Límite de 5 registros por minuto por IP: si otra prueba lo agotó, esperamos.
for (let i = 0; r.status === 429 && i < 8; i++) {
  console.log('  … límite de registros por minuto alcanzado, esperando 10 s');
  await new Promise((res) => setTimeout(res, 10_000));
  r = await call('POST', '/auth/register', { email, password, fullName: 'Ana Prueba' });
}
expect(r.status === 201, 'registro crea la cuenta', r.data);

r = await call('POST', '/auth/login', { email, password });
expect(r.status === 403, 'no deja entrar sin verificar el correo', r.data);

r = await call('POST', '/auth/verify-email', { email, code: '000000' });
expect(r.status === 400, 'rechaza un código incorrecto', r.data);

const verifyCode = await latestCode(email, 'Verifica tu correo');
r = await call('POST', '/auth/verify-email', { email, code: verifyCode });
expect(r.status === 200 && r.data.accessToken, 'verifica el correo y entrega tokens', r.data);

r = await call('POST', '/auth/login', { email, password: 'Incorrecta1' });
expect(r.status === 401, 'rechaza contraseña incorrecta', r.data);

r = await call('POST', '/auth/login', { email, password });
expect(r.status === 200 && r.data.accessToken && r.data.refreshToken, 'login con contraseña entrega tokens (sin código)', r.data);
const { accessToken, refreshToken } = r.data;

r = await call('GET', '/auth/me', undefined, accessToken);
expect(r.status === 200 && r.data.email === email, '/me devuelve el usuario', r.data);

r = await call('GET', '/auth/me');
expect(r.status === 401, '/me sin token responde 401', r.data);

r = await call('POST', '/auth/pin', { pin: '1234', password }, accessToken);
expect(r.status === 400, 'rechaza un PIN demasiado simple', r.data);

r = await call('POST', '/auth/pin', { pin: '4821', password }, accessToken);
expect(r.status === 200, 'configura el PIN de pagos', r.data);

r = await call('POST', '/auth/pin/verify', { pin: '4821' }, accessToken);
expect(r.status === 200 && r.data.valid, 'verifica el PIN correcto', r.data);

r = await call('POST', '/auth/refresh', { refreshToken });
expect(r.status === 200 && r.data.refreshToken !== refreshToken, 'refresh rota el token', r.data);
const newRefresh = r.data.refreshToken;

r = await call('POST', '/auth/refresh', { refreshToken });
expect(r.status === 401, 'reusar un refresh viejo cierra las sesiones', r.data);

r = await call('POST', '/auth/refresh', { refreshToken: newRefresh });
expect(r.status === 401, 'tras el reuso, el refresh nuevo también quedó revocado', r.data);

console.log('\nTodo el flujo de autenticación funciona ✔');
