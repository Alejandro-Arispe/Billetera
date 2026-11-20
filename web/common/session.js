// Sesión compartida por las páginas web de la billetera (/kyc, /admin).
// Login en dos pasos: contraseña -> código enviado por correo.
const API = '/api';
const KEY = 'billetera.session';

export function session() {
  try { return JSON.parse(sessionStorage.getItem(KEY)); } catch { return null; }
}
export function clearSession() {
  try { sessionStorage.removeItem(KEY); } catch { /* modo privado */ }
}
function saveSession(s) {
  try { sessionStorage.setItem(KEY, JSON.stringify(s)); } catch { /* modo privado */ }
}

/** Datos del JWT (rol, correo). Solo para decidir qué mostrar; el servidor valida de verdad. */
export function claims() {
  const t = session()?.accessToken;
  if (!t) return null;
  try { return JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch { return null; }
}

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

/** Llama a la API. `body` puede ser un objeto (JSON) o un FormData (archivos). */
export async function api(method, path, body, { raw = false } = {}) {
  const s = session();
  const isForm = body instanceof FormData;
  const res = await fetch(API + path, {
    method,
    headers: {
      ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}),
      ...(s?.accessToken ? { Authorization: `Bearer ${s.accessToken}` } : {}),
    },
    body: isForm ? body : body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && s?.accessToken) {
    // Intenta renovar la sesión una vez con el refresh token.
    const r = await fetch(`${API}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: s.refreshToken }),
    });
    if (r.ok) {
      saveSession(await r.json());
      return api(method, path, body, { raw });
    }
    clearSession();
    location.reload();
  }
  if (raw && res.ok) return res;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(Array.isArray(data.message) ? data.message.join('. ') : data.message || 'Error', res.status);
  }
  return data;
}

/** Dibuja el login (correo/contraseña y luego código) dentro de `root` y resuelve al entrar. */
export function login(root, title = 'Inicia sesión') {
  return new Promise((resolve) => {
    root.innerHTML = `
      <section class="card">
        <h1></h1>
        <p class="alert hidden" role="alert"></p>
        <form data-step="password">
          <label>Correo <input name="email" type="email" autocomplete="email" required /></label>
          <label>Contraseña <input name="password" type="password" autocomplete="current-password" required /></label>
          <button class="primary" type="submit">Continuar</button>
        </form>
        <form data-step="code" class="hidden">
          <p class="muted" data-msg></p>
          <label>Código de 6 dígitos
            <input name="code" inputmode="numeric" pattern="\\d{6}" maxlength="6" autocomplete="one-time-code" required class="code" />
          </label>
          <button class="primary" type="submit">Verificar</button>
        </form>
      </section>`;
    root.querySelector('h1').textContent = title;
    const alert = root.querySelector('.alert');
    const [pwForm, codeForm] = root.querySelectorAll('form');
    let challengeId = null;

    const guard = (form, fn) => async (e) => {
      e.preventDefault();
      alert.classList.add('hidden');
      form.querySelector('button').disabled = true;
      try { await fn(new FormData(form)); } catch (err) {
        alert.textContent = err.message;
        alert.classList.remove('hidden');
      } finally { form.querySelector('button').disabled = false; }
    };

    pwForm.addEventListener('submit', guard(pwForm, async (f) => {
      const r = await api('POST', '/auth/login', { email: f.get('email'), password: f.get('password') });
      challengeId = r.challengeId;
      codeForm.querySelector('[data-msg]').textContent = r.message;
      pwForm.classList.add('hidden');
      codeForm.classList.remove('hidden');
      codeForm.querySelector('input').focus();
    }));

    codeForm.addEventListener('submit', guard(codeForm, async (f) => {
      saveSession(await api('POST', '/auth/login/verify', { challengeId, code: f.get('code') }));
      resolve(claims());
    }));
  });
}

export function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}
