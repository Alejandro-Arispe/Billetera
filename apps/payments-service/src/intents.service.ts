import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThanOrEqual, Repository } from 'typeorm';
import {
  callInternal,
  ChargeRequest,
  ChargeResult,
  Currency,
  fromMinor,
  InternalAccount,
  InternalUser,
  toMinor,
} from '@app/common';
import { CreateIntentDto, PayDto } from './dto';
import { IntentStatus, Merchant, OPEN_STATUSES, PaymentIntent } from './entities';
import { QrService } from './qr.service';
import { WebhookEvent, WebhooksService } from './webhooks.service';

const DEFAULT_TTL_SECONDS = 300;

/**
 * Ciclo de vida de un cobro QR:
 *
 *   POS crea el intent ──► CREATED ──(cliente escanea)──► SCANNED ──(paga con PIN)──► PROCESSING ──► PAID
 *                              │                              │
 *                              └──────── vence ───────────────┴──► EXPIRED     (o el POS cancela ──► CANCELLED)
 *
 * En cada cambio relevante se avisa al comercio por webhook.
 */
@Injectable()
export class IntentsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IntentsService.name);
  private readonly authUrl: string;
  private readonly walletUrl: string;
  private timer?: NodeJS.Timeout;

  constructor(
    @InjectRepository(PaymentIntent) private readonly intents: Repository<PaymentIntent>,
    @InjectRepository(Merchant) private readonly merchants: Repository<Merchant>,
    private readonly qr: QrService,
    private readonly webhooks: WebhooksService,
    config: ConfigService,
  ) {
    this.authUrl = config.get('AUTH_SERVICE_URL', 'http://localhost:3001');
    this.walletUrl = config.get('WALLET_SERVICE_URL', 'http://localhost:3002');
  }

  onModuleInit() {
    this.timer = setInterval(() => void this.expireDue().catch(() => undefined), 5000);
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  // ------------------------------------------------------------------ lado del comercio

  async create(merchant: Merchant, dto: CreateIntentDto) {
    const amountMinor = toMinor(dto.amount, dto.currency);
    if (amountMinor <= 0) throw new BadRequestException('El monto debe ser mayor a 0');
    if (dto.items?.length) {
      const sum = dto.items.reduce((s, it) => s + toMinor(it.unitPrice, dto.currency) * it.quantity, 0);
      if (sum !== amountMinor) {
        throw new BadRequestException(
          `La suma de los productos (${fromMinor(sum, dto.currency)}) no coincide con el monto (${dto.amount})`,
        );
      }
    }

    // Misma referencia = mismo pedido: si el POS reintenta, devolvemos el mismo QR.
    const existing = await this.intents.findOne({ where: { merchantId: merchant.id, reference: dto.reference } });
    if (existing) {
      if (existing.amountMinor === amountMinor && existing.currency === dto.currency) {
        return this.merchantView(existing, true);
      }
      throw new ConflictException('Ya existe un cobro con esa referencia y otro monto');
    }

    const intent = await this.intents.save(
      this.intents.create({
        merchantId: merchant.id,
        amountMinor,
        currency: dto.currency,
        reference: dto.reference,
        description: dto.description?.trim() || `Compra en ${merchant.name}`,
        items: dto.items ?? [],
        expiresAt: new Date(Date.now() + (dto.expiresInSeconds ?? DEFAULT_TTL_SECONDS) * 1000),
      }),
    );
    return this.merchantView(intent, true);
  }

  async getForMerchant(merchant: Merchant, id: string) {
    const intent = await this.intents.findOne({ where: { id, merchantId: merchant.id } });
    if (!intent) throw new NotFoundException('Cobro no encontrado');
    return this.merchantView(await this.refreshExpiry(intent, merchant), true);
  }

  async list(merchant: Merchant, status?: IntentStatus) {
    const rows = await this.intents.find({
      where: { merchantId: merchant.id, ...(status ? { status } : {}) },
      order: { createdAt: 'DESC' },
      take: 50,
    });
    return Promise.all(rows.map((r) => this.merchantView(r, false)));
  }

  async cancel(merchant: Merchant, id: string) {
    const intent = await this.intents.findOne({ where: { id, merchantId: merchant.id } });
    if (!intent) throw new NotFoundException('Cobro no encontrado');
    const res = await this.intents.update(
      { id, status: In(OPEN_STATUSES) },
      { status: IntentStatus.CANCELLED },
    );
    if (!res.affected) throw new ConflictException(`No se puede cancelar un cobro en estado ${intent.status}`);
    intent.status = IntentStatus.CANCELLED;
    await this.notify(merchant, intent, 'payment_intent.canceled');
    return this.merchantView(intent, false);
  }

  async webhookLog(merchant: Merchant, id: string) {
    await this.getForMerchant(merchant, id);
    return (await this.webhooks.listForIntent(id)).map((d) => ({
      event: d.eventType,
      status: d.status,
      attempts: d.attempts,
      lastStatusCode: d.lastStatusCode,
      lastError: d.lastError,
      createdAt: d.createdAt,
    }));
  }

  // ------------------------------------------------------------------ lado del cliente (billetera)

  /** El cliente escaneó el QR: validamos firma y vigencia y le mostramos qué va a pagar. */
  async scan(userId: string, qrText: string) {
    const { intentId, signature } = this.qr.parse(qrText);
    const intent = await this.intents.findOne({ where: { id: intentId } });
    if (!intent) throw new NotFoundException('Cobro no encontrado');
    this.qr.verify(intent, signature);
    const merchant = await this.merchants.findOneOrFail({ where: { id: intent.merchantId } });
    await this.assertPayable(await this.refreshExpiry(intent, merchant));
    if (merchant.ownerUserId === userId) throw new ForbiddenException('No puedes pagar un cobro de tu propio comercio');

    if (intent.status === IntentStatus.CREATED) {
      const res = await this.intents.update(
        { id: intent.id, status: IntentStatus.CREATED },
        { status: IntentStatus.SCANNED, scannedAt: new Date() },
      );
      if (res.affected) {
        intent.status = IntentStatus.SCANNED;
        await this.notify(merchant, intent, 'payment_intent.scanned');
      }
    }
    return { ...this.payerView(intent, merchant), fundingOptions: await this.fundingOptions(userId, intent) };
  }

  /** El cliente confirma con su PIN. Se cobra de forma atómica e idempotente. */
  async pay(userId: string, intentId: string, dto: PayDto) {
    const intent = await this.intents.findOne({ where: { id: intentId } });
    if (!intent) throw new NotFoundException('Cobro no encontrado');
    const merchant = await this.merchants.findOneOrFail({ where: { id: intent.merchantId } });
    await this.assertPayable(await this.refreshExpiry(intent, merchant));
    if (merchant.ownerUserId === userId) throw new ForbiddenException('No puedes pagar un cobro de tu propio comercio');

    await callInternal(this.authUrl, `/internal/users/${userId}/verify-pin`, {
      method: 'POST',
      body: { pin: dto.pin },
    });
    const payer = await callInternal<InternalUser>(this.authUrl, `/internal/users/${userId}`);

    // Tomamos el cobro: solo un request puede pasar de CREATED/SCANNED a PROCESSING.
    const taken = await this.intents
      .createQueryBuilder()
      .update()
      .set({ status: IntentStatus.PROCESSING, payerUserId: userId, payerName: payer.fullName })
      .where('id = :id AND status IN (:...open) AND expires_at > now()', { id: intent.id, open: OPEN_STATUSES })
      .execute();
    if (!taken.affected) throw new ConflictException('Este cobro ya se está pagando o ya fue pagado');

    const fundingCurrency: Currency = dto.fundingCurrency ?? intent.currency;
    const charge: ChargeRequest = {
      userId,
      creditUserId: merchant.ownerUserId,
      amountMinor: intent.amountMinor,
      currency: intent.currency,
      fundingCurrency,
      type: 'QR_PAYMENT',
      description: `Pago QR en ${merchant.name}`,
      idempotencyKey: `qr:${intent.id}`,
      metadata: {
        merchantId: merchant.id,
        merchantName: merchant.name,
        payerName: payer.fullName,
        intentId: intent.id,
        reference: intent.reference,
      },
    };

    let result: ChargeResult;
    try {
      result = await callInternal<ChargeResult>(this.walletUrl, '/internal/wallet/charges', {
        method: 'POST',
        body: charge,
      });
    } catch (err) {
      // No se cobró (p. ej. saldo insuficiente): el QR vuelve a quedar disponible.
      await this.intents.update(
        { id: intent.id, status: IntentStatus.PROCESSING },
        { status: IntentStatus.SCANNED, payerUserId: null, payerName: null },
      );
      throw err;
    }

    Object.assign(intent, {
      status: IntentStatus.PAID,
      paidAt: new Date(),
      payerUserId: userId,
      payerName: payer.fullName,
      walletTransactionId: result.transactionId,
      debitedMinor: result.debitedMinor,
      debitedCurrency: result.debitedCurrency,
    });
    await this.intents.save(intent);
    this.logger.log(`Cobro ${intent.reference} de ${merchant.name} PAGADO por ${payer.fullName}`);
    await this.notify(merchant, intent, 'payment_intent.succeeded');

    return {
      ...this.payerView(intent, merchant),
      transactionId: result.transactionId,
      debited: fromMinor(result.debitedMinor, result.debitedCurrency),
      debitedCurrency: result.debitedCurrency,
      rate: result.rate,
      paidAt: intent.paidAt,
    };
  }

  // ------------------------------------------------------------------ helpers

  private async fundingOptions(userId: string, intent: PaymentIntent) {
    const accounts = await callInternal<InternalAccount[]>(this.walletUrl, `/internal/wallet/accounts/${userId}`);
    return Promise.all(
      accounts.map(async (a) => {
        const preview = await callInternal<{ debitedMinor: number; rate: string | null }>(
          this.walletUrl,
          '/internal/wallet/charges/preview',
          { method: 'POST', body: { amountMinor: intent.amountMinor, currency: intent.currency, fundingCurrency: a.currency } },
        );
        return {
          currency: a.currency,
          balance: a.balance,
          debit: fromMinor(preview.debitedMinor, a.currency),
          rate: preview.rate,
          sufficient: a.balanceMinor >= preview.debitedMinor,
        };
      }),
    );
  }

  private async assertPayable(intent: PaymentIntent) {
    switch (intent.status) {
      case IntentStatus.PAID:
        throw new ConflictException('Este cobro ya fue pagado');
      case IntentStatus.PROCESSING:
        throw new ConflictException('Este cobro se está procesando');
      case IntentStatus.CANCELLED:
        throw new GoneException('El comercio canceló este cobro');
      case IntentStatus.EXPIRED:
        throw new GoneException('El QR expiró. Pide al comercio que genere uno nuevo.');
    }
  }

  /** Si ya venció, lo marca como EXPIRED en el momento (no espera al proceso periódico). */
  private async refreshExpiry(intent: PaymentIntent, merchant: Merchant) {
    if (OPEN_STATUSES.includes(intent.status) && intent.expiresAt <= new Date()) {
      const res = await this.intents.update(
        { id: intent.id, status: In(OPEN_STATUSES) },
        { status: IntentStatus.EXPIRED },
      );
      intent.status = IntentStatus.EXPIRED;
      if (res.affected) await this.notify(merchant, intent, 'payment_intent.expired');
    }
    return intent;
  }

  private async expireDue() {
    const due = await this.intents.find({
      where: { status: In(OPEN_STATUSES), expiresAt: LessThanOrEqual(new Date()) },
      take: 100,
    });
    for (const intent of due) {
      const merchant = await this.merchants.findOne({ where: { id: intent.merchantId } });
      if (merchant) await this.refreshExpiry(intent, merchant);
    }
  }

  private async notify(merchant: Merchant, intent: PaymentIntent, event: WebhookEvent) {
    await this.webhooks.emit(merchant, intent.id, event, { object: await this.merchantView(intent, false) });
  }

  async merchantView(i: PaymentIntent, withQr: boolean) {
    const open = OPEN_STATUSES.includes(i.status);
    return {
      id: i.id,
      object: 'payment_intent',
      status: i.status,
      amount: fromMinor(i.amountMinor, i.currency),
      currency: i.currency,
      reference: i.reference,
      description: i.description,
      items: i.items,
      expiresAt: i.expiresAt,
      createdAt: i.createdAt,
      scannedAt: i.scannedAt,
      paidAt: i.paidAt,
      payer: i.payerName && i.status === IntentStatus.PAID ? { name: i.payerName } : null,
      walletTransactionId: i.walletTransactionId,
      ...(withQr && open ? { qr: { payload: this.qr.payload(i), image: await this.qr.image(i) } } : {}),
    };
  }

  private payerView(i: PaymentIntent, m: Merchant) {
    return {
      intentId: i.id,
      status: i.status,
      merchant: { id: m.id, name: m.name },
      amount: fromMinor(i.amountMinor, i.currency),
      currency: i.currency,
      description: i.description,
      items: i.items,
      expiresAt: i.expiresAt,
    };
  }
}
