// Prueba de punta a punta de la Etapa 4: verificación de identidad (KYC) y panel de administración.
// Requiere `npm run infra:up` y `npm run dev`.   Uso: npm run smoke:kyc
import { admin, call, env, kycForm, lastMailSubject, mailCode, sleep, TINY_PNG } from './lib.mjs';

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

console.log('\n== Usuario sin verificar ==');
const carla = await newUser('Carla Ruiz', '5813');
let r = await call('GET', '/kyc/status', { token: carla.token });
expect(r.status === 200 && r.data.status === 'NOT_STARTED' && r.data.canSubmit, 'estado inicial: sin verificar', r.data);
r = await call('POST', '/cards', { token: carla.token, body: { pin: '5813' } });
expect(r.status === 403 && r.data.missing?.includes('Identidad verificada'), 'sin identidad no puede habilitar la tarjeta', r.data);
r = await call('GET', '/kyc/admin/submissions', { token: carla.token });
expect(r.status === 403, 'un usuario común no entra al panel de administración', r.data);

console.log('\n== Validaciones del envío ==');
r = await call('POST', '/kyc/submissions', { token: carla.token, body: kycForm({}, { selfie: null }).form });
expect(r.status === 400 && /selfie/i.test(r.data.message), 'falta la selfie', r.data);
r = await call('POST', '/kyc/submissions', { token: carla.token, body: kycForm({}, { documentBack: null }).form });
expect(r.status === 400 && /dorso/i.test(r.data.message), 'DNI sin dorso es rechazado', r.data);
r = await call('POST', '/kyc/submissions', { token: carla.token, body: kycForm({}, { selfie: Buffer.from('esto no es una imagen') }).form });
expect(r.status === 400 && /selfie/i.test(r.data.message), 'archivo que no es imagen es rechazado', r.data);
r = await call('POST', '/kyc/submissions', { token: carla.token, body: kycForm({ phone: '1234', documentType: 'LICENCIA' }).form });
expect(r.status === 400 && Array.isArray(r.data.message) && r.data.message.length >= 2, `datos inválidos: ${r.data.message?.join(' / ')}`, r.data);

console.log('\n== Rechazo automático ==');
const since = new Date(Date.now() - 1000);
r = await call('POST', '/kyc/submissions', {
  token: carla.token,
  body: kycForm({ firstName: 'Carla', lastName: 'Ruiz', birthDate: '2015-01-01', documentExpiresAt: '2020-01-01' }).form,
});
expect(r.status === 201 && r.data.status === 'REJECTED' && r.data.canSubmit,
  `menor de edad y documento vencido: rechazo automático ("${r.data.rejectionReason}")`, r.data);
expect(await lastMailSubject(carla.email, 'No pudimos verificar', since), 'le llegó el correo de rechazo');

console.log('\n== Envío correcto y revisión manual ==');
const dni = String(30_000_000 + Math.floor(Math.random() * 60_000_000));
const good = kycForm({ firstName: 'Carla', lastName: 'Ruiz Díaz', documentNumber: dni }, { documentFront: TINY_PNG });
r = await call('POST', '/kyc/submissions', { token: carla.token, body: good.form });
expect(r.status === 201 && r.data.status === 'PENDING' && !r.data.canSubmit, 'enviada: queda EN REVISIÓN', r.data);
const subId = r.data.submission.id;
expect(r.data.submission.documentNumberMasked === `••••${dni.slice(-4)}`, 'el usuario ve el documento enmascarado', r.data.submission);
r = await call('POST', '/kyc/submissions', { token: carla.token, body: good.form });
expect(r.status === 409, 'no puede reenviar mientras está en revisión', r.data);

const adminToken = await admin();
r = await call('GET', '/kyc/admin/submissions?status=PENDING', { token: adminToken });
expect(r.status === 200 && r.data.items.some((i) => i.id === subId), `el admin la ve en la cola (${r.data.counts.PENDING} pendientes)`, r.data);
r = await call('GET', `/kyc/admin/submissions/${subId}`, { token: adminToken });
expect(r.data.documentNumber === dni && r.data.checks.every((c) => c.result !== 'FAIL'),
  `detalle con documento descifrado y ${r.data.checks.length} verificaciones automáticas`, r.data.checks);
const img = await fetch(`${env.API_URL ?? 'http://localhost:4000/api'}/kyc/admin/submissions/${subId}/files/selfie`, {
  headers: { Authorization: `Bearer ${adminToken}` },
});
const bytes = Buffer.from(await img.arrayBuffer());
expect(img.status === 200 && img.headers.get('content-type') === 'image/png' && bytes.equals(TINY_PNG),
  'el admin ve la selfie (se descifró idéntica a la enviada)');
r = await call('GET', `/kyc/admin/submissions/${subId}/files/selfie`, { token: carla.token });
expect(r.status === 403, 'el usuario no puede bajar fotos desde el panel', r.status);

const since2 = new Date(Date.now() - 1000);
r = await call('POST', `/kyc/admin/submissions/${subId}/approve`, { token: adminToken });
expect(r.status === 200 && r.data.status === 'APPROVED' && r.data.reviewedBy === env.ADMIN_EMAIL, 'el admin aprueba la identidad', r.data);
r = await call('POST', `/kyc/admin/submissions/${subId}/reject`, { token: adminToken, body: { reason: 'Intento tardío' } });
expect(r.status === 409, 'no se puede cambiar una decisión ya tomada', r.data);
expect(await lastMailSubject(carla.email, 'Tu identidad fue verificada', since2), 'le llegó el correo de aprobación');

r = await call('GET', '/kyc/status', { token: carla.token });
expect(r.data.status === 'APPROVED' && !r.data.canSubmit, 'estado del usuario: verificada', r.data);
r = await call('GET', '/auth/me', { token: carla.token });
expect(r.data.kycStatus === 'APPROVED' && r.data.fullName === 'Carla Ruiz Díaz', 'la cuenta toma el nombre legal del documento', r.data);
r = await call('POST', '/cards', { token: carla.token, body: { pin: '5813' } });
expect(r.status === 201 && r.data.holderName === 'CARLA RUIZ DIAZ', `ahora habilita la tarjeta a nombre de ${r.data.holderName}`, r.data);

console.log('\n== Documento duplicado y rechazo manual ==');
const dario = await newUser('Darío Luna', '9152');
r = await call('POST', '/kyc/submissions', {
  token: dario.token,
  body: kycForm({ firstName: 'Darío', lastName: 'Luna', documentNumber: dni }).form,
});
expect(r.data.status === 'REJECTED' && /otra cuenta/.test(r.data.rejectionReason), 'el mismo documento en otra cuenta se rechaza', r.data);
r = await call('POST', '/kyc/submissions', {
  token: dario.token,
  body: kycForm({ firstName: 'Darío', lastName: 'Luna', documentType: 'PASSPORT', documentNumber: `AB${dni.slice(0, 7)}` }, { documentBack: null }).form,
});
expect(r.data.status === 'PENDING', 'reenvía con pasaporte (sin dorso): en revisión', r.data);
r = await call('POST', `/kyc/admin/submissions/${r.data.submission.id}/reject`, {
  token: adminToken,
  body: { reason: 'La selfie no coincide con la foto del pasaporte' },
});
expect(r.data.status === 'REJECTED', 'el admin rechaza con motivo', r.data);
r = await call('GET', '/kyc/status', { token: dario.token });
expect(r.data.status === 'REJECTED' && r.data.canSubmit && r.data.rejectionReason.includes('selfie'),
  'el usuario ve el motivo y puede volver a intentar', r.data);

r = await fetch('http://localhost:4000/kyc');
expect(r.status === 200 && (await r.text()).includes('Verificar identidad'), 'la página /kyc está publicada');
r = await fetch('http://localhost:4000/admin');
expect(r.status === 200 && (await r.text()).includes('Panel de administración'), 'la página /admin está publicada');

console.log('\nEtapa 4 funciona de punta a punta ✔');
