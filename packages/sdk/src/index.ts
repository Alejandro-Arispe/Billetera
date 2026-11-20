/**
 * @billetera/sdk — cobra con la Billetera desde cualquier proyecto Node.js (POS, tienda online, bot…).
 *
 *   import { Billetera } from '@billetera/sdk';
 *   const billetera = new Billetera({ apiKey: process.env.BILLETERA_API_KEY, baseUrl: 'http://localhost:4000/api' });
 *   const cobro = await billetera.payments.create({ amount: '7.00', currency: 'USD', reference: 'ORD-1001' });
 *   // mostrar cobro.qr.image (PNG en data URL) y esperar el webhook o:
 *   const pagado = await billetera.payments.waitForStatus(cobro.id, ['PAID']);
 *
 * Sin dependencias: usa fetch y crypto de Node 18+.
 */
import { createHmac, timingSafeEqual } from 'crypto';

export type Currency = 'USD' | 'EUR' | 'ARS';
export type PaymentStatus = 'CREATED' | 'SCANNED' | 'PROCESSING' | 'PAID' | 'EXPIRED' | 'CANCELLED';
export type WebhookEventType =
  | 'payment_intent.scanned'
  | 'payment_intent.succeeded'
  | 'payment_intent.expired'
  | 'payment_intent.canceled';

export interface PaymentItem {
  name: string;
  quantity: number;
  /** Precio unitario como texto con 2 decimales: "3.50". */
  unitPrice: string;
}

export interface CreatePaymentParams {
  /** Monto como texto con 2 decimales ("7.00"). Nunca uses números con decimales para dinero. */
  amount: string;
  currency: Currency;
  /** Id único del pedido en tu sistema. Reintentar con la misma referencia devuelve el mismo cobro. */
  reference: string;
  description?: string;
  /** Si se envían, deben sumar exactamente `amount`. */
  items?: PaymentItem[];
  /** Vigencia del QR en segundos (15 a 3600). Por defecto 300. */
  expiresInSeconds?: number;
}

export interface Payment {
  id: string;
  object: 'payment_intent';
  status: PaymentStatus;
  amount: string;
  currency: Currency;
  reference: string;
  description: string;
  items: PaymentItem[];
  expiresAt: string;
  createdAt: string;
  scannedAt: string | null;
  paidAt: string | null;
  payer: { name: string } | null;
  walletTransactionId: string | null;
  /** Solo mientras el cobro está pendiente. */
  qr?: { payload: string; image: string };
}

export interface WebhookEvent {
  id: string;
  type: WebhookEventType;
  createdAt: string;
  data: { object: Payment };
}

export interface BilleteraOptions {
  /** API key secreta del comercio (sk_test_…). Guárdala en el servidor, nunca en el navegador. */
  apiKey: string;
  /** URL de la API, por ejemplo http://localhost:4000/api */
  baseUrl?: string;
  /** Tiempo máximo por request en ms. Por defecto 10000. */
  timeoutMs?: number;
}

export class BilleteraError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'BilleteraError';
  }
}

export class Billetera {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  readonly payments: {
    create: (params: CreatePaymentParams) => Promise<Payment>;
    retrieve: (id: string) => Promise<Payment>;
    list: (params?: { status?: PaymentStatus }) => Promise<Payment[]>;
    cancel: (id: string) => Promise<Payment>;
    waitForStatus: (
      id: string,
      statuses?: PaymentStatus[],
      opts?: { timeoutMs?: number; intervalMs?: number },
    ) => Promise<Payment>;
  };

  constructor(opts: BilleteraOptions) {
    if (!opts?.apiKey) throw new Error('Falta apiKey');
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? 'http://localhost:4000/api').replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? 10_000;

    this.payments = {
      create: (params) => this.request<Payment>('POST', '/payments/intents', params),
      retrieve: (id) => this.request<Payment>('GET', `/payments/intents/${encodeURIComponent(id)}`),
      list: (params) =>
        this.request<Payment[]>('GET', `/payments/intents${params?.status ? `?status=${params.status}` : ''}`),
      cancel: (id) => this.request<Payment>('POST', `/payments/intents/${encodeURIComponent(id)}/cancel`),
      /**
       * Consulta el cobro hasta que llegue a uno de los estados indicados (por defecto, un estado final).
       * Útil si tu sistema no puede recibir webhooks. Con webhooks no hace falta.
       */
      waitForStatus: async (id, statuses = ['PAID', 'EXPIRED', 'CANCELLED'], o = {}) => {
        const deadline = Date.now() + (o.timeoutMs ?? 5 * 60_000);
        for (;;) {
          const p = await this.payments.retrieve(id);
          if (statuses.includes(p.status)) return p;
          if (['PAID', 'EXPIRED', 'CANCELLED'].includes(p.status)) return p; // ya no va a cambiar
          if (Date.now() > deadline) throw new BilleteraError('Tiempo de espera agotado', 408, p);
          await new Promise((r) => setTimeout(r, o.intervalMs ?? 2000));
        }
      },
    };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', 'x-api-key': this.apiKey },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new BilleteraError(`No se pudo conectar con la Billetera: ${(err as Error).message}`, 0, null);
    }
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const msg = Array.isArray(data?.message) ? data.message.join('. ') : data?.message;
      throw new BilleteraError(msg ?? `Error ${res.status}`, res.status, data);
    }
    return data as T;
  }
}

/**
 * Verifica la firma de un webhook y devuelve el evento.
 * Pásale el cuerpo CRUDO (Buffer o string exactamente como llegó), la cabecera
 * `Billetera-Signature` y tu secreto de webhooks (whsec_…). Lanza error si no es válido.
 *
 *   app.post('/webhooks/billetera', express.raw({ type: 'application/json' }), (req, res) => {
 *     const event = verifyWebhook(req.body, req.header('billetera-signature'), process.env.BILLETERA_WEBHOOK_SECRET);
 *     if (event.type === 'payment_intent.succeeded') marcarPagado(event.data.object.reference);
 *     res.sendStatus(200);
 *   });
 */
export function verifyWebhook(
  rawBody: Buffer | string,
  signatureHeader: string | undefined | null,
  secret: string,
  toleranceSeconds = 300,
): WebhookEvent {
  if (!signatureHeader) throw new BilleteraError('Webhook sin firma', 400, null);
  const parts = Object.fromEntries(
    signatureHeader.split(',').map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    }),
  );
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > toleranceSeconds) {
    throw new BilleteraError('Webhook vencido o con fecha inválida', 400, null);
  }
  const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  const given = String(parts.v1 ?? '');
  if (given.length !== expected.length || !timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
    throw new BilleteraError('Firma de webhook inválida', 400, null);
  }
  return JSON.parse(body) as WebhookEvent;
}

/** Genera la cabecera de firma (para tests de tu integración). */
export function signWebhook(rawBody: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

export default Billetera;
