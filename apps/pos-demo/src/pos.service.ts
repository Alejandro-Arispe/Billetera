import { BadRequestException, Injectable, Logger, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { Observable, Subject, filter, map, startWith } from 'rxjs';
import { Billetera, BilleteraError, Payment, verifyWebhook } from '@billetera/sdk';

/**
 * POS de demostración = "otro proyecto" que integra la billetera como medio de pago.
 * No comparte código ni base de datos con la billetera: usa el SDK público (@billetera/sdk)
 * con la API key del comercio y verifica los webhooks firmados. Así se integraría en cualquier sistema.
 */

export interface Product {
  id: string;
  name: string;
  emoji: string;
  price: string;
}

export const CATALOG: Product[] = [
  { id: 'cafe', name: 'Café americano', emoji: '☕', price: '2.50' },
  { id: 'latte', name: 'Café latte', emoji: '🥛', price: '3.50' },
  { id: 'medialuna', name: 'Medialuna', emoji: '🥐', price: '1.20' },
  { id: 'sandwich', name: 'Sándwich jamón y queso', emoji: '🥪', price: '5.90' },
  { id: 'jugo', name: 'Jugo de naranja', emoji: '🍊', price: '3.00' },
  { id: 'torta', name: 'Torta de chocolate', emoji: '🍰', price: '4.25' },
  { id: 'agua', name: 'Agua mineral', emoji: '💧', price: '1.50' },
  { id: 'ensalada', name: 'Ensalada César', emoji: '🥗', price: '7.80' },
];

export type OrderStatus = 'OPEN' | 'WAITING_PAYMENT' | 'SCANNED' | 'PAID' | 'EXPIRED' | 'CANCELLED';

export interface Order {
  id: string;
  number: number;
  items: { productId: string; name: string; quantity: number; unitPrice: string }[];
  total: string;
  currency: string;
  status: OrderStatus;
  method: 'QR' | 'CARD' | null;
  intentId: string | null;
  qrImage: string | null;
  qrPayload: string | null;
  expiresAt: string | null;
  payerName: string | null;
  transactionId: string | null;
  approvalCode: string | null;
  paidAt: string | null;
  events: { at: string; text: string }[];
  createdAt: string;
}

const cents = (s: string) => Math.round(Number(s) * 100);
const money = (c: number) => (c / 100).toFixed(2);

@Injectable()
export class PosService {
  private readonly logger = new Logger(PosService.name);
  private readonly orders = new Map<string, Order>(); // demo: en memoria
  private readonly updates = new Subject<Order>();
  private readonly seenEvents = new Set<string>();
  private seq = 1000;

  readonly storeName: string;
  readonly currency: string;
  private readonly api: string;
  private readonly apiKey: string;
  private readonly webhookSecret: string;
  private readonly cardKey: string;
  private readonly billetera: Billetera | null;

  constructor(config: ConfigService) {
    this.storeName = config.get('POS_STORE_NAME', 'Cafetería Demo');
    this.currency = config.get('POS_CURRENCY', 'USD');
    this.api = config.get('POS_BILLETERA_API', 'http://localhost:4000/api').replace(/\/$/, '');
    this.apiKey = config.get('POS_API_KEY', '');
    this.webhookSecret = config.get('POS_WEBHOOK_SECRET', '');
    this.cardKey = config.get('POS_CARD_ACQUIRER_KEY', 'demo-pos-key');
    this.billetera = this.apiKey ? new Billetera({ apiKey: this.apiKey, baseUrl: this.api }) : null;
  }

  get configured() {
    return !!this.apiKey && !!this.webhookSecret;
  }

  createOrder(lines: { productId: string; quantity: number }[]): Order {
    if (!lines?.length) throw new BadRequestException('El carrito está vacío');
    const items = lines.map((l) => {
      const p = CATALOG.find((x) => x.id === l.productId);
      const q = Math.floor(Number(l.quantity));
      if (!p || !(q >= 1 && q <= 99)) throw new BadRequestException('Producto o cantidad inválidos');
      return { productId: p.id, name: p.name, quantity: q, unitPrice: p.price };
    });
    const total = items.reduce((s, it) => s + cents(it.unitPrice) * it.quantity, 0);
    const order: Order = {
      id: randomUUID(),
      number: ++this.seq,
      items,
      total: money(total),
      currency: this.currency,
      status: 'OPEN',
      method: null,
      intentId: null,
      qrImage: null,
      qrPayload: null,
      expiresAt: null,
      payerName: null,
      transactionId: null,
      approvalCode: null,
      paidAt: null,
      events: [],
      createdAt: new Date().toISOString(),
    };
    this.orders.set(order.id, order);
    this.log(order, `Orden #${order.number} creada por ${order.currency} ${order.total}`);
    return order;
  }

  get(id: string): Order {
    const o = this.orders.get(id);
    if (!o) throw new NotFoundException('Orden no encontrada');
    return o;
  }

  /** Pide a la billetera un cobro QR para la orden. */
  async chargeWithQr(id: string): Promise<Order> {
    const order = this.get(id);
    if (!this.configured) throw new ServiceUnavailableException('POS sin configurar: ejecuta "npm run pos:setup"');
    if (order.status === 'PAID') throw new BadRequestException('La orden ya está pagada');
    if (order.status === 'WAITING_PAYMENT' || order.status === 'SCANNED') return order;

    // Si un QR anterior venció o se canceló, se usa otra referencia para crear uno nuevo.
    const attempt = order.events.filter((e) => e.text.startsWith('QR generado')).length;
    const intent = await this.sdk((b) => b.payments.create({
      amount: order.total,
      currency: order.currency as Payment['currency'],
      reference: attempt ? `${order.id}-${attempt}` : order.id,
      description: `${this.storeName} · Orden #${order.number}`,
      items: order.items.map((i) => ({ name: i.name, quantity: i.quantity, unitPrice: i.unitPrice })),
      expiresInSeconds: 300,
    }));
    Object.assign(order, {
      status: 'WAITING_PAYMENT',
      method: 'QR',
      intentId: intent.id,
      qrImage: intent.qr?.image ?? null,
      qrPayload: intent.qr?.payload ?? null,
      expiresAt: intent.expiresAt,
    });
    this.log(order, 'QR generado, esperando pago');
    return order;
  }

  /** Cobro con la tarjeta virtual: el cajero rellena los datos que le dicta/muestra el cliente. */
  async chargeWithCard(id: string, card: { cardNumber: string; expMonth: number; expYear: number; cvv: string }) {
    const order = this.get(id);
    if (order.status === 'PAID') throw new BadRequestException('La orden ya está pagada');
    if (order.intentId && ['WAITING_PAYMENT', 'SCANNED'].includes(order.status)) {
      await this.sdk((b) => b.payments.cancel(order.intentId!)).catch(() => undefined);
    }
    const r = await fetch(`${this.api}/cards/authorizations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': this.cardKey },
      body: JSON.stringify({
        ...card,
        amount: order.total,
        currency: order.currency,
        merchantName: this.storeName,
        reference: `${order.id}-card-${Date.now()}`,
      }),
    });
    const auth = await r.json();
    if (!r.ok) throw new BadRequestException(auth.message ?? 'Error al cobrar con tarjeta');
    if (auth.status === 'APPROVED') {
      Object.assign(order, {
        status: 'PAID',
        method: 'CARD',
        approvalCode: auth.approvalCode,
        transactionId: auth.walletTransactionId,
        paidAt: new Date().toISOString(),
      });
      this.log(order, `Pagado con tarjeta •••• ${auth.cardLast4} (aprobación ${auth.approvalCode})`);
    } else {
      this.log(order, `Tarjeta rechazada: ${auth.message}`);
    }
    return { order, authorization: auth };
  }

  async cancel(id: string) {
    const order = this.get(id);
    if (order.status === 'PAID') throw new BadRequestException('No se puede cancelar una orden pagada');
    if (order.intentId && ['WAITING_PAYMENT', 'SCANNED'].includes(order.status)) {
      await this.sdk((b) => b.payments.cancel(order.intentId!)).catch(() => undefined);
    }
    order.status = 'CANCELLED';
    this.log(order, 'Orden cancelada');
    return order;
  }

  /** Consulta manual del estado (por si el webhook no llega, p. ej. sin red). */
  async refresh(id: string) {
    const order = this.get(id);
    if (!order.intentId) return order;
    const intent = await this.sdk((b) => b.payments.retrieve(order.intentId!));
    this.applyIntent(order, intent, 'consulta manual');
    return order;
  }

  /** Recibe los webhooks de la billetera y verifica su firma antes de confiar en ellos. */
  handleWebhook(rawBody: Buffer | undefined, signature: string | undefined) {
    if (!rawBody) throw new UnauthorizedException('Webhook sin cuerpo');
    let event;
    try {
      event = verifyWebhook(rawBody, signature, this.webhookSecret);
    } catch (err) {
      throw new UnauthorizedException((err as Error).message);
    }
    if (this.seenEvents.has(event.id)) return { received: true, duplicate: true };
    this.seenEvents.add(event.id);

    const intent = event.data.object;
    const order = [...this.orders.values()].find((o) => o.intentId === intent.id);
    if (!order) return { received: true, ignored: 'orden desconocida' };
    this.applyIntent(order, intent, `webhook ${event.type}`);
    return { received: true };
  }

  stream(id: string): Observable<{ data: Order }> {
    const order = this.get(id);
    return this.updates.pipe(
      filter((o) => o.id === id),
      startWith(order),
      map((o) => ({ data: o })),
    );
  }

  private applyIntent(order: Order, intent: Payment, source: string) {
    const before = order.status;
    switch (intent.status) {
      case 'SCANNED':
      case 'PROCESSING':
        if (order.status === 'WAITING_PAYMENT') order.status = 'SCANNED';
        break;
      case 'PAID':
        Object.assign(order, {
          status: 'PAID',
          payerName: intent.payer?.name ?? null,
          paidAt: intent.paidAt ?? new Date().toISOString(),
          transactionId: intent.walletTransactionId ?? null,
        });
        break;
      case 'EXPIRED':
        if (order.status !== 'PAID') order.status = 'EXPIRED';
        break;
      case 'CANCELLED':
        if (order.status !== 'PAID') order.status = 'CANCELLED';
        break;
    }
    if (order.status !== before) {
      const texts: Record<string, string> = {
        SCANNED: 'El cliente escaneó el QR',
        PAID: `PAGADO${order.payerName ? ` por ${order.payerName}` : ''}`,
        EXPIRED: 'El QR venció',
        CANCELLED: 'Cobro cancelado',
      };
      this.log(order, `${texts[order.status] ?? order.status} (${source})`);
    }
  }

  private log(order: Order, text: string) {
    order.events.push({ at: new Date().toISOString(), text });
    this.logger.log(`#${order.number}: ${text}`);
    this.updates.next(order);
  }

  /** Ejecuta una llamada del SDK traduciendo sus errores a respuestas HTTP del POS. */
  private async sdk<T>(fn: (b: Billetera) => Promise<T>): Promise<T> {
    if (!this.billetera) throw new ServiceUnavailableException('POS sin configurar: ejecuta "npm run pos:setup"');
    try {
      return await fn(this.billetera);
    } catch (err) {
      if (err instanceof BilleteraError && err.status === 0) throw new ServiceUnavailableException(err.message);
      throw new BadRequestException((err as Error).message);
    }
  }
}
