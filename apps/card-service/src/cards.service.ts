import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomInt, timingSafeEqual } from 'crypto';
import { MoreThanOrEqual, Not, Repository } from 'typeorm';
import {
  callInternal,
  ChargeRequest,
  ChargeResult,
  fromMinor,
  InternalUser,
  toMinor,
} from '@app/common';
import { CardCrypto, isLuhnValid } from './card-crypto';
import { AuthorizeDto, LimitDto } from './dto';
import { AuthorizationStatus, Card, CardAuthorization, CardStatus } from './entities';

const DEFAULT_MONTHLY_LIMIT_MINOR = 1_000_000; // 10,000.00 USD
const MAX_MONTHLY_LIMIT_MINOR = 5_000_000; // 50,000.00 USD
const CARD_VALIDITY_YEARS = 4;

export type DeclineCode =
  | 'INVALID_CARD'
  | 'EXPIRED_CARD'
  | 'INVALID_CVV'
  | 'CARD_FROZEN'
  | 'CARD_CANCELLED'
  | 'LIMIT_EXCEEDED'
  | 'INSUFFICIENT_FUNDS';

const DECLINE_MESSAGES: Record<DeclineCode, string> = {
  INVALID_CARD: 'Tarjeta inválida',
  EXPIRED_CARD: 'Tarjeta vencida o fecha incorrecta',
  INVALID_CVV: 'Código de seguridad incorrecto',
  CARD_FROZEN: 'La tarjeta está pausada',
  CARD_CANCELLED: 'La tarjeta fue dada de baja',
  LIMIT_EXCEEDED: 'Supera el límite mensual de la tarjeta',
  INSUFFICIENT_FUNDS: 'Fondos insuficientes',
};

@Injectable()
export class CardsService {
  private readonly logger = new Logger(CardsService.name);
  private readonly authUrl: string;
  private readonly walletUrl: string;
  private readonly requireKyc: boolean;
  private readonly billingAddress: Record<string, string>;

  constructor(
    @InjectRepository(Card) private readonly cards: Repository<Card>,
    @InjectRepository(CardAuthorization) private readonly auths: Repository<CardAuthorization>,
    private readonly crypto: CardCrypto,
    config: ConfigService,
  ) {
    this.authUrl = config.get('AUTH_SERVICE_URL', 'http://localhost:3001');
    this.walletUrl = config.get('WALLET_SERVICE_URL', 'http://localhost:3002');
    this.requireKyc = config.get('CARD_REQUIRE_KYC', 'false') === 'true';
    this.billingAddress = {
      line1: config.get('CARD_BILLING_LINE1', '100 Simulation Ave'),
      city: config.get('CARD_BILLING_CITY', 'Miami'),
      state: config.get('CARD_BILLING_STATE', 'FL'),
      postalCode: config.get('CARD_BILLING_ZIP', '33101'),
      country: config.get('CARD_BILLING_COUNTRY', 'US'),
    };
  }

  // ---------------------------------------------------------------- Apartado "Tarjetas"

  /** Qué le falta al usuario para poder habilitar su tarjeta (pantalla previa al botón). */
  async eligibility(userId: string) {
    const user = await this.user(userId);
    const active = await this.cards.count({ where: { userId, status: Not(CardStatus.CANCELLED) } });
    const requirements = [
      { key: 'EMAIL_VERIFIED', label: 'Correo verificado', done: user.status === 'ACTIVE', required: true },
      { key: 'PIN_SET', label: 'PIN de pagos configurado', done: user.hasPin, required: true },
      {
        key: 'IDENTITY_VERIFIED',
        label: 'Identidad verificada',
        done: user.kycStatus === 'APPROVED',
        required: this.requireKyc,
      },
      { key: 'NO_ACTIVE_CARD', label: 'Sin otra tarjeta virtual activa', done: active === 0, required: true },
    ];
    return {
      eligible: requirements.every((r) => r.done || !r.required),
      requirements,
      offer: {
        product: 'Tarjeta virtual de débito',
        brand: 'VISA',
        currency: 'USD',
        fundedBy: 'Saldo en USD de tu billetera',
        issuanceFee: '0.00',
        monthlyFee: '0.00',
        defaultMonthlyLimit: fromMinor(DEFAULT_MONTHLY_LIMIT_MINOR, 'USD'),
      },
    };
  }

  /** Botón "Habilitar tarjeta": emite la tarjeta virtual al instante. Requiere PIN. */
  async issue(userId: string, pin: string) {
    const status = await this.eligibility(userId);
    if (!status.eligible) {
      const missing = status.requirements.filter((r) => r.required && !r.done).map((r) => r.label);
      throw new ForbiddenException({
        statusCode: 403,
        code: 'NOT_ELIGIBLE',
        message: `Para habilitar la tarjeta te falta: ${missing.join(', ')}`,
        missing,
      });
    }
    await this.verifyPin(userId, pin);
    const user = await this.user(userId);

    const now = new Date();
    for (let attempt = 0; attempt < 5; attempt++) {
      const pan = this.crypto.generatePan();
      try {
        const card = await this.cards.save(
          this.cards.create({
            userId,
            holderName: embossName(user.fullName),
            panEncrypted: this.crypto.encrypt(pan),
            panHash: this.crypto.panHash(pan),
            last4: pan.slice(-4),
            expMonth: now.getMonth() + 1,
            expYear: now.getFullYear() + CARD_VALIDITY_YEARS,
            cvvEncrypted: this.crypto.encrypt(this.crypto.generateCvv()),
            monthlyLimitMinor: DEFAULT_MONTHLY_LIMIT_MINOR,
          }),
        );
        this.logger.log(`Tarjeta •••• ${card.last4} emitida para el usuario ${userId}`);
        return this.view(card);
      } catch (err) {
        if ((err as { code?: string }).code !== '23505') throw err; // número repetido: reintenta
      }
    }
    throw new ConflictException('No se pudo generar la tarjeta, intenta de nuevo');
  }

  async list(userId: string) {
    const cards = await this.cards.find({ where: { userId }, order: { createdAt: 'DESC' } });
    return Promise.all(cards.map((c) => this.view(c)));
  }

  /** "Ver datos": número completo, vencimiento, CVV y dirección de facturación para pagar online. */
  async details(userId: string, cardId: string, pin: string) {
    const card = await this.owned(userId, cardId);
    if (card.status === CardStatus.CANCELLED) throw new BadRequestException('La tarjeta fue dada de baja');
    await this.verifyPin(userId, pin);
    const pan = this.crypto.decrypt(card.panEncrypted);
    this.logger.log(`Datos de la tarjeta •••• ${card.last4} revelados al usuario ${userId}`);
    return {
      cardId: card.id,
      holderName: card.holderName,
      number: pan.replace(/(\d{4})(?=\d)/g, '$1 '),
      expMonth: card.expMonth,
      expYear: card.expYear,
      expiry: `${String(card.expMonth).padStart(2, '0')}/${String(card.expYear).slice(-2)}`,
      cvv: this.crypto.decrypt(card.cvvEncrypted),
      brand: card.brand,
      currency: card.currency,
      billingAddress: this.billingAddress,
    };
  }

  async freeze(userId: string, cardId: string) {
    const card = await this.owned(userId, cardId);
    if (card.status === CardStatus.CANCELLED) throw new BadRequestException('La tarjeta fue dada de baja');
    card.status = CardStatus.FROZEN;
    return this.view(await this.cards.save(card));
  }

  async unfreeze(userId: string, cardId: string) {
    const card = await this.owned(userId, cardId);
    if (card.status === CardStatus.CANCELLED) throw new BadRequestException('La tarjeta fue dada de baja');
    card.status = CardStatus.ACTIVE;
    return this.view(await this.cards.save(card));
  }

  async setLimit(userId: string, cardId: string, dto: LimitDto) {
    const card = await this.owned(userId, cardId);
    const limit = toMinor(dto.monthlyLimit, card.currency);
    if (limit < 100 || limit > MAX_MONTHLY_LIMIT_MINOR) {
      throw new BadRequestException(`El límite debe estar entre 1.00 y ${fromMinor(MAX_MONTHLY_LIMIT_MINOR, 'USD')} USD`);
    }
    card.monthlyLimitMinor = limit;
    return this.view(await this.cards.save(card));
  }

  async cancel(userId: string, cardId: string, pin: string) {
    const card = await this.owned(userId, cardId);
    await this.verifyPin(userId, pin);
    card.status = CardStatus.CANCELLED;
    return this.view(await this.cards.save(card));
  }

  async transactions(userId: string, cardId: string) {
    const card = await this.owned(userId, cardId);
    const rows = await this.auths.find({
      where: { cardId: card.id },
      order: { createdAt: 'DESC' },
      take: 50,
    });
    return rows.map((a) => this.authView(a, card));
  }

  // ---------------------------------------------------------------- "Red de tarjetas" simulada

  /**
   * Autoriza una compra con los datos que el usuario rellenó en el checkout / terminal.
   * Valida número, vencimiento, CVV, estado y límite; luego cobra el saldo USD en wallet-service.
   */
  async authorize(dto: AuthorizeDto) {
    // Sin tarjeta no hay a quién asociar el intento, así que no se registra.
    const declineNoCard = {
      status: AuthorizationStatus.DECLINED,
      declineCode: 'INVALID_CARD' as DeclineCode,
      message: DECLINE_MESSAGES.INVALID_CARD,
    };
    if (!isLuhnValid(dto.cardNumber)) return declineNoCard;
    const card = await this.cards.findOne({ where: { panHash: this.crypto.panHash(dto.cardNumber) } });
    if (!card) return declineNoCard;

    // Reintento del comercio con la misma referencia: devolvemos la misma aprobación.
    const previous = await this.auths.findOne({
      where: { cardId: card.id, merchantReference: dto.reference, status: AuthorizationStatus.APPROVED },
    });
    if (previous) return this.authView(previous, card);

    const amountMinor = toMinor(dto.amount, dto.currency);
    if (amountMinor <= 0) throw new BadRequestException('El monto debe ser mayor a 0');
    const base = {
      cardId: card.id,
      userId: card.userId,
      amountMinor,
      currency: dto.currency,
      merchantName: dto.merchantName.trim(),
      merchantReference: dto.reference,
    };
    const decline = async (code: DeclineCode) => {
      const a = await this.auths.save(
        this.auths.create({ ...base, status: AuthorizationStatus.DECLINED, declineCode: code }),
      );
      return this.authView(a, card);
    };

    const expYear = dto.expYear < 100 ? 2000 + dto.expYear : dto.expYear;
    const cvvOk = safeEqual(dto.cvv, this.crypto.decrypt(card.cvvEncrypted));
    if (card.status === CardStatus.CANCELLED) return decline('CARD_CANCELLED');
    if (expYear !== card.expYear || dto.expMonth !== card.expMonth || isExpired(card)) return decline('EXPIRED_CARD');
    if (!cvvOk) return decline('INVALID_CVV');
    if (card.status === CardStatus.FROZEN) return decline('CARD_FROZEN');

    // Límite mensual, medido en la moneda de la tarjeta (USD).
    const preview = await callInternal<{ debitedMinor: number }>(this.walletUrl, '/internal/wallet/charges/preview', {
      method: 'POST',
      body: { amountMinor, currency: dto.currency, fundingCurrency: card.currency },
    });
    if ((await this.spentThisMonth(card.id)) + preview.debitedMinor > card.monthlyLimitMinor) {
      return decline('LIMIT_EXCEEDED');
    }

    const charge: ChargeRequest = {
      userId: card.userId,
      amountMinor,
      currency: dto.currency,
      fundingCurrency: card.currency,
      type: 'CARD_PAYMENT',
      description: `Compra con tarjeta en ${base.merchantName}`,
      idempotencyKey: `card:${card.id}:${dto.reference}`,
      metadata: { merchantName: base.merchantName, reference: dto.reference, cardLast4: card.last4 },
    };
    let result: ChargeResult;
    try {
      result = await callInternal<ChargeResult>(this.walletUrl, '/internal/wallet/charges', {
        method: 'POST',
        body: charge,
      });
    } catch (err) {
      if (err instanceof HttpException && err.getStatus() === 422) return decline('INSUFFICIENT_FUNDS');
      throw err;
    }

    const approved = await this.auths.save(
      this.auths.create({
        ...base,
        status: AuthorizationStatus.APPROVED,
        debitedMinor: result.debitedMinor,
        approvalCode: randomInt(0, 1_000_000).toString().padStart(6, '0'),
        walletTransactionId: result.transactionId,
      }),
    );
    return this.authView(approved, card);
  }

  // ---------------------------------------------------------------- helpers

  private async spentThisMonth(cardId: string): Promise<number> {
    const start = new Date();
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    const rows = await this.auths.find({
      where: { cardId, status: AuthorizationStatus.APPROVED, createdAt: MoreThanOrEqual(start) },
    });
    return rows.reduce((s, a) => s + (a.debitedMinor ?? 0), 0);
  }

  private async view(card: Card) {
    const spent = await this.spentThisMonth(card.id);
    return {
      id: card.id,
      type: card.type,
      brand: card.brand,
      holderName: card.holderName,
      maskedNumber: `•••• •••• •••• ${card.last4}`,
      last4: card.last4,
      expiry: `${String(card.expMonth).padStart(2, '0')}/${String(card.expYear).slice(-2)}`,
      currency: card.currency,
      status: card.status,
      monthlyLimit: fromMinor(card.monthlyLimitMinor, card.currency),
      spentThisMonth: fromMinor(spent, card.currency),
      availableThisMonth: fromMinor(Math.max(card.monthlyLimitMinor - spent, 0), card.currency),
      createdAt: card.createdAt,
    };
  }

  private authView(a: CardAuthorization, card: Card) {
    return {
      authorizationId: a.id,
      status: a.status,
      ...(a.status === AuthorizationStatus.APPROVED
        ? { approvalCode: a.approvalCode, message: 'Pago aprobado' }
        : { declineCode: a.declineCode, message: DECLINE_MESSAGES[a.declineCode as DeclineCode] }),
      merchantName: a.merchantName,
      reference: a.merchantReference,
      amount: fromMinor(a.amountMinor, a.currency),
      currency: a.currency,
      ...(a.debitedMinor !== null
        ? { debited: fromMinor(a.debitedMinor, card.currency), debitedCurrency: card.currency }
        : {}),
      cardLast4: card.last4,
      walletTransactionId: a.walletTransactionId,
      createdAt: a.createdAt,
    };
  }

  private async owned(userId: string, cardId: string): Promise<Card> {
    const card = await this.cards.findOne({ where: { id: cardId, userId } });
    if (!card) throw new NotFoundException('Tarjeta no encontrada');
    return card;
  }

  private user(userId: string) {
    return callInternal<InternalUser>(this.authUrl, `/internal/users/${userId}`);
  }

  private verifyPin(userId: string, pin: string) {
    return callInternal(this.authUrl, `/internal/users/${userId}/verify-pin`, { method: 'POST', body: { pin } });
  }
}

/** Nombre como va impreso en la tarjeta: mayúsculas, sin acentos, máx. 26 caracteres. */
function embossName(fullName: string): string {
  return fullName
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z ]/g, '')
    .trim()
    .toUpperCase()
    .slice(0, 26);
}

function isExpired(card: Card): boolean {
  const now = new Date();
  return card.expYear < now.getFullYear() || (card.expYear === now.getFullYear() && card.expMonth < now.getMonth() + 1);
}

function safeEqual(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

