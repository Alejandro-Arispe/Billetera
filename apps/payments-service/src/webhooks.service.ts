import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHmac, randomUUID } from 'crypto';
import { LessThanOrEqual, Repository } from 'typeorm';
import { DeliveryStatus, Merchant, WebhookDelivery } from './entities';

/** Reintentos con espera creciente: 10 s, 30 s, 2 min, 10 min, 30 min. */
const BACKOFF_SECONDS = [10, 30, 120, 600, 1800];

export type WebhookEvent =
  | 'payment_intent.scanned'
  | 'payment_intent.succeeded'
  | 'payment_intent.expired'
  | 'payment_intent.canceled';

/**
 * Notifica a los comercios por HTTP POST (como Stripe/Mercado Pago).
 * Cabecera de firma: `Billetera-Signature: t=<timestamp>,v1=<hmac>` donde
 * hmac = HMAC-SHA256(webhookSecret, `${t}.${cuerpo}`). El comercio la verifica
 * para saber que el aviso viene de la billetera y no de un tercero.
 */
@Injectable()
export class WebhooksService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebhooksService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    @InjectRepository(WebhookDelivery) private readonly deliveries: Repository<WebhookDelivery>,
    @InjectRepository(Merchant) private readonly merchants: Repository<Merchant>,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.retryDue(), 5000);
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  /** Encola el evento y lo intenta enviar de inmediato (sin bloquear la respuesta al cliente). */
  async emit(merchant: Merchant, intentId: string, type: WebhookEvent, data: Record<string, unknown>) {
    if (!merchant.webhookUrl) return;
    const delivery = await this.deliveries.save(
      this.deliveries.create({
        merchantId: merchant.id,
        intentId,
        eventType: type,
        payload: { id: `evt_${randomUUID()}`, type, createdAt: new Date().toISOString(), data },
        nextAttemptAt: new Date(),
      }),
    );
    void this.attempt(delivery, merchant);
  }

  async listForIntent(intentId: string) {
    return this.deliveries.find({ where: { intentId }, order: { createdAt: 'ASC' } });
  }

  private async retryDue() {
    if (this.running) return;
    this.running = true;
    try {
      const due = await this.deliveries.find({
        where: { status: DeliveryStatus.PENDING, nextAttemptAt: LessThanOrEqual(new Date()) },
        take: 20,
      });
      for (const d of due) {
        const merchant = await this.merchants.findOne({ where: { id: d.merchantId } });
        if (merchant) await this.attempt(d, merchant);
      }
    } catch (err) {
      this.logger.error(`Error reintentando webhooks: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private async attempt(d: WebhookDelivery, merchant: Merchant) {
    if (!merchant.webhookUrl) return;
    // Reserva el intento para que el reintento periódico no lo envíe en paralelo.
    const lock = await this.deliveries.update(
      { id: d.id, status: DeliveryStatus.PENDING, attempts: d.attempts },
      { attempts: d.attempts + 1, nextAttemptAt: new Date(Date.now() + 60_000) },
    );
    if (!lock.affected) return;
    d.attempts += 1;

    const body = JSON.stringify(d.payload);
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac('sha256', merchant.webhookSecret).update(`${t}.${body}`).digest('hex');
    try {
      const res = await fetch(merchant.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Billetera-Signature': `t=${t},v1=${v1}`,
          'Billetera-Event': d.eventType,
        },
        body,
        signal: AbortSignal.timeout(8000),
      });
      d.lastStatusCode = res.status;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      d.status = DeliveryStatus.DELIVERED;
      d.lastError = null;
      this.logger.log(`Webhook ${d.eventType} entregado a ${merchant.name}`);
    } catch (err) {
      d.lastError = (err as Error).message.slice(0, 250);
      const wait = BACKOFF_SECONDS[d.attempts - 1];
      if (wait === undefined) {
        d.status = DeliveryStatus.FAILED;
      } else {
        d.nextAttemptAt = new Date(Date.now() + wait * 1000);
      }
      this.logger.warn(`Webhook ${d.eventType} a ${merchant.name} falló (${d.lastError}); intento ${d.attempts}`);
    }
    await this.deliveries.save(d);
  }
}
