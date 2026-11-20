// Cliente de la API de la billetera (a través del gateway en /api).
// La sesión se guarda en localStorage para que la app instalada no pida login cada vez;
// el access token dura 15 min y se renueva solo con el refresh token (rotación en cada uso).

export type Currency = 'BOB' | 'USD' | 'EUR';
export const CURRENCIES: Currency[] = ['BOB', 'USD', 'EUR'];

export interface Session {
  accessToken: string;
  refreshToken: string;
}

export interface Me {
  id: string;
  email: string;
  fullName: string;
  role: 'USER' | 'MERCHANT' | 'ADMIN';
  status: string;
  kycStatus: 'NOT_STARTED' | 'PENDING' | 'APPROVED' | 'REJECTED';
  hasPin: boolean;
  createdAt: string;
}

export interface Account {
  id: string;
  currency: Currency;
  balance: string;
}

export interface Movement {
  transactionId: string;
  type: 'TOPUP' | 'P2P_TRANSFER' | 'FX_CONVERSION' | 'CARD_PAYMENT' | 'QR_PAYMENT' | 'REFUND';
  direction: 'IN' | 'OUT';
  amount: string;
  currency: Currency;
  balanceAfter: string;
  description: string;
  counterparty: string | null;
  createdAt: string;
}

export interface Receipt {
  transactionId: string;
  type: Movement['type'];
  status: string;
  description: string;
  createdAt: string;
  counterparty: string | null;
  movements: { currency: Currency; amount: string; balanceAfter: string }[];
  rate?: string;
}

export interface Card {
  id: string;
  brand: string;
  holderName: string;
  maskedNumber: string;
  last4: string;
  expiry: string;
  currency: Currency;
  status: 'ACTIVE' | 'FROZEN' | 'CANCELLED';
  monthlyLimit: string;
  spentThisMonth: string;
  availableThisMonth: string;
}

export interface CardDetails {
  number: string;
  expiry: string;
  expMonth: number;
  expYear: number;
  cvv: string;
  holderName: string;
  billingAddress: Record<string, string>;
}

const KEY = 'billetera.session';
let listeners: ((s: Session | null) => void)[] = [];

export function getSession(): Session | null {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? 'null');
  } catch {
    return null;
  }
}

export function setSession(s: Session | null) {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    /* almacenamiento bloqueado: la sesión dura lo que la pestaña */
  }
  memory = s;
  listeners.forEach((l) => l(s));
}

let memory: Session | null = getSession();

export function onSessionChange(fn: (s: Session | null) => void) {
  listeners.push(fn);
  return () => {
    listeners = listeners.filter((l) => l !== fn);
  };
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

let refreshing: Promise<boolean> | null = null;

async function refresh(): Promise<boolean> {
  const s = memory ?? getSession();
  if (!s) return false;
  refreshing ??= (async () => {
    const res = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: s.refreshToken }),
    });
    if (!res.ok) {
      setSession(null);
      return false;
    }
    setSession(await res.json());
    return true;
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

export async function api<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  opts: { headers?: Record<string, string>; retry?: boolean } = {},
): Promise<T> {
  const s = memory ?? getSession();
  const isForm = body instanceof FormData;
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : {}),
      ...(s ? { Authorization: `Bearer ${s.accessToken}` } : {}),
      ...opts.headers,
    },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });

  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  // Token vencido: se renueva y se repite la llamada una vez.
  // (Un 401 con token válido, p. ej. "PIN incorrecto", trae otro mensaje y no se reintenta.)
  if (res.status === 401 && s && opts.retry !== false && /token/i.test(String(data.message))) {
    if (await refresh()) return api<T>(method, path, body, { ...opts, retry: false });
  }
  if (!res.ok) {
    const msg = Array.isArray(data.message) ? data.message.join('. ') : data.message;
    throw new ApiError(msg || `Error ${res.status}`, res.status, data);
  }
  return data as T;
}

export async function logout() {
  const s = getSession();
  if (s) await api('POST', '/auth/logout', { refreshToken: s.refreshToken }).catch(() => undefined);
  setSession(null);
}

export const idemKey = () => crypto.randomUUID();
