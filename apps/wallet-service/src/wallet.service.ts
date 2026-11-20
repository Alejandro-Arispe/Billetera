import {
  BadRequestException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import {
  callInternal,
  ChargeRequest,
  ChargeResult,
  Currency,
  fromMinor,
  InternalAccount,
  InternalUser,
  isCurrency,
  SUPPORTED_CURRENCIES,
  toMinor,
} from '@app/common';
import { Account, FxQuote, LedgerEntry, TransactionType, WalletTransaction } from './entities';
import { FxService } from './fx.service';
import { AccountRef, Leg, LedgerService } from './ledger.service';
import { FxQuoteDto, HistoryQueryDto, TopupDto, TransferDto } from './dto';

const QUOTE_TTL_SECONDS = 30;

@Injectable()
export class WalletService {
  private readonly authUrl: string;
  private readonly maxTopupMinor: number;

  constructor(
    private readonly ledger: LedgerService,
    private readonly fx: FxService,
    @InjectRepository(Account) private readonly accounts: Repository<Account>,
    @InjectRepository(LedgerEntry) private readonly entries: Repository<LedgerEntry>,
    @InjectRepository(WalletTransaction) private readonly txs: Repository<WalletTransaction>,
    @InjectRepository(FxQuote) private readonly quotes: Repository<FxQuote>,
    config: ConfigService,
  ) {
    this.authUrl = config.get('AUTH_SERVICE_URL', 'http://localhost:3001');
    this.maxTopupMinor = Number(config.get('MAX_TOPUP_AMOUNT', 5000)) * 100;
  }

  async balances(userId: string) {
    await this.ledger.ensureUserAccounts(userId);
    const list = await this.accounts.find({ where: { userId } });
    const order = (c: Currency) => SUPPORTED_CURRENCIES.indexOf(c);
    return list
      .filter((a) => order(a.currency) >= 0)
      .sort((a, b) => order(a.currency) - order(b.currency))
      .map((a) => ({ id: a.id, currency: a.currency, balance: fromMinor(a.balanceMinor, a.currency) }));
  }

  /** Recarga simulada (como si llegara una transferencia bancaria). */
  async topup(userId: string, dto: TopupDto) {
    const amountMinor = toMinor(dto.amount, dto.currency);
    if (amountMinor <= 0) throw new BadRequestException('El monto debe ser mayor a 0');
    if (amountMinor > this.maxTopupMinor) {
      throw new BadRequestException(`El máximo por recarga es ${fromMinor(this.maxTopupMinor, dto.currency)}`);
    }
    const tx = await this.ledger.post({
      type: TransactionType.TOPUP,
      description: `Recarga de ${dto.amount} ${dto.currency}`,
      initiatedBy: userId,
      legs: [
        { account: { system: 'TOPUP_SOURCE', currency: dto.currency }, amountMinor: -amountMinor },
        { account: { userId, currency: dto.currency }, amountMinor },
      ],
    });
    return this.receipt(tx.id, userId);
  }

  /** Envío de dinero a otro usuario por su correo (P2P). Requiere PIN. */
  async transfer(userId: string, dto: TransferDto, idempotencyKey?: string) {
    const amountMinor = toMinor(dto.amount, dto.currency);
    if (amountMinor <= 0) throw new BadRequestException('El monto debe ser mayor a 0');

    await callInternal(this.authUrl, `/internal/users/${userId}/verify-pin`, {
      method: 'POST',
      body: { pin: dto.pin },
    });
    const [sender, recipient] = await Promise.all([
      callInternal<InternalUser>(this.authUrl, `/internal/users/${userId}`),
      callInternal<InternalUser>(this.authUrl, `/internal/users/by-email?email=${encodeURIComponent(dto.toEmail)}`),
    ]);
    if (recipient.id === userId) throw new BadRequestException('No puedes enviarte dinero a ti mismo');

    const tx = await this.ledger.post({
      type: TransactionType.P2P_TRANSFER,
      description: dto.description?.trim() || `Envío a ${recipient.fullName}`,
      initiatedBy: userId,
      idempotencyKey: idempotencyKey ? `p2p:${userId}:${idempotencyKey}` : null,
      metadata: {
        from: { id: sender.id, name: sender.fullName, email: sender.email },
        to: { id: recipient.id, name: recipient.fullName, email: recipient.email },
      },
      legs: [
        { account: { userId, currency: dto.currency }, amountMinor: -amountMinor },
        { account: { userId: recipient.id, currency: dto.currency }, amountMinor },
      ],
    });
    return this.receipt(tx.id, userId);
  }

  async rates() {
    const snap = await this.fx.snapshot();
    const pairs = [];
    for (const from of SUPPORTED_CURRENCIES) {
      for (const to of SUPPORTED_CURRENCIES) {
        if (from === to) continue;
        pairs.push({
          from,
          to,
          mid: round(await this.fx.midRate(from, to)),
          customer: round(await this.fx.customerRate(from, to)),
        });
      }
    }
    return { source: snap.source, fetchedAt: snap.fetchedAt, spread: this.fx.spread, pairs };
  }

  /** Cotiza una conversión y congela la tasa durante 30 segundos. */
  async quote(userId: string, dto: FxQuoteDto) {
    const amountFromMinor = toMinor(dto.amount, dto.from);
    if (amountFromMinor <= 0) throw new BadRequestException('El monto debe ser mayor a 0');
    const { rate, amountToMinor } = await this.fx.convertOut(dto.from, dto.to, amountFromMinor);
    if (amountToMinor <= 0) throw new BadRequestException('Monto demasiado chico para convertir');

    const q = await this.quotes.save(
      this.quotes.create({
        userId,
        fromCurrency: dto.from,
        toCurrency: dto.to,
        amountFromMinor,
        amountToMinor,
        rate: rate.toFixed(8),
        expiresAt: new Date(Date.now() + QUOTE_TTL_SECONDS * 1000),
      }),
    );
    return this.quoteView(q);
  }

  /** Ejecuta una cotización vigente. */
  async convert(userId: string, quoteId: string) {
    const q = await this.quotes.findOne({ where: { id: quoteId, userId } });
    if (!q) throw new NotFoundException('Cotización no encontrada');
    if (q.usedAt) throw new BadRequestException('Esta cotización ya fue utilizada');
    if (q.expiresAt < new Date()) throw new GoneException('La cotización expiró. Pide una nueva.');

    // Marcar como usada de forma atómica evita ejecutar la misma cotización dos veces.
    const marked = await this.quotes.update({ id: q.id, usedAt: IsNull() }, { usedAt: new Date() });
    if (!marked.affected) throw new BadRequestException('Esta cotización ya fue utilizada');

    try {
      const tx = await this.ledger.post({
        type: TransactionType.FX_CONVERSION,
        description: `Cambio ${q.fromCurrency} → ${q.toCurrency}`,
        initiatedBy: userId,
        idempotencyKey: `fx:${q.id}`,
        metadata: { quoteId: q.id, rate: q.rate },
        legs: [
          { account: { userId, currency: q.fromCurrency }, amountMinor: -q.amountFromMinor },
          { account: { system: 'FX_POOL', currency: q.fromCurrency }, amountMinor: q.amountFromMinor },
          { account: { system: 'FX_POOL', currency: q.toCurrency }, amountMinor: -q.amountToMinor },
          { account: { userId, currency: q.toCurrency }, amountMinor: q.amountToMinor },
        ],
      });
      return this.receipt(tx.id, userId);
    } catch (err) {
      await this.quotes.update({ id: q.id }, { usedAt: null }); // p.ej. saldo insuficiente: se puede reintentar
      throw err;
    }
  }

  async history(userId: string, q: HistoryQueryDto) {
    const where = { userId, ...(q.currency ? { currency: q.currency } : {}) };
    const [rows, total] = await this.entries.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
    });
    const txs = rows.length
      ? await this.txs.findBy(rows.map((r) => ({ id: r.transactionId })))
      : [];
    const txById = new Map(txs.map((t) => [t.id, t]));

    return {
      page: q.page,
      limit: q.limit,
      total,
      items: rows.map((e) => {
        const tx = txById.get(e.transactionId)!;
        return {
          transactionId: tx.id,
          type: tx.type,
          status: tx.status,
          direction: e.amountMinor > 0 ? 'IN' : 'OUT',
          amount: fromMinor(Math.abs(e.amountMinor), e.currency),
          currency: e.currency,
          balanceAfter: fromMinor(e.balanceAfterMinor, e.currency),
          description: tx.description,
          counterparty: counterparty(tx, userId),
          createdAt: e.createdAt,
        };
      }),
    };
  }

  /** Comprobante de una transacción, visto desde un usuario. */
  async receipt(transactionId: string, userId: string) {
    const tx = await this.txs.findOne({ where: { id: transactionId } });
    if (!tx) throw new NotFoundException('Transacción no encontrada');
    const mine = await this.entries.find({ where: { transactionId, userId } });
    if (!mine.length) throw new NotFoundException('Transacción no encontrada');
    return {
      transactionId: tx.id,
      type: tx.type,
      status: tx.status,
      description: tx.description,
      createdAt: tx.createdAt,
      counterparty: counterparty(tx, userId),
      movements: mine.map((e) => ({
        currency: e.currency,
        amount: fromMinor(e.amountMinor, e.currency),
        balanceAfter: fromMinor(e.balanceAfterMinor, e.currency),
      })),
      ...(tx.metadata.rate ? { rate: tx.metadata.rate } : {}),
    };
  }

  /**
   * Cobro interno (tarjeta o QR). Si la moneda del comercio es distinta a la de la cuenta
   * que paga, se convierte al vuelo: el usuario paga en su moneda y el comercio cobra en la suya.
   */
  async charge(req: ChargeRequest): Promise<ChargeResult> {
    if (!Number.isSafeInteger(req.amountMinor) || req.amountMinor <= 0) {
      throw new BadRequestException('Monto inválido');
    }
    if (!isCurrency(req.currency) || !isCurrency(req.fundingCurrency)) {
      throw new BadRequestException('Moneda no soportada');
    }
    if (!req.userId || !req.idempotencyKey) throw new BadRequestException('Faltan datos del cobro');
    const settlement = req.type === 'CARD_PAYMENT' ? 'CARD_SETTLEMENT' : 'QR_SETTLEMENT';
    const type = req.type === 'CARD_PAYMENT' ? TransactionType.CARD_PAYMENT : TransactionType.QR_PAYMENT;

    if (req.creditUserId === req.userId) {
      throw new BadRequestException('No puedes pagarte a ti mismo');
    }
    // Destino del dinero: la billetera del comercio, o la cuenta de liquidación del sistema.
    const creditAccount: AccountRef = req.creditUserId
      ? { userId: req.creditUserId, currency: req.currency }
      : { system: settlement, currency: req.currency };

    let debitedMinor = req.amountMinor;
    let rate: string | null = null;
    let legs: Leg[];
    if (req.currency === req.fundingCurrency) {
      legs = [
        { account: { userId: req.userId, currency: req.currency }, amountMinor: -req.amountMinor },
        { account: creditAccount, amountMinor: req.amountMinor },
      ];
    } else {
      const conv = await this.fx.convertIn(req.fundingCurrency, req.currency, req.amountMinor);
      debitedMinor = conv.amountFromMinor;
      rate = conv.rate.toFixed(8);
      legs = [
        { account: { userId: req.userId, currency: req.fundingCurrency }, amountMinor: -debitedMinor },
        { account: { system: 'FX_POOL', currency: req.fundingCurrency }, amountMinor: debitedMinor },
        { account: { system: 'FX_POOL', currency: req.currency }, amountMinor: -req.amountMinor },
        { account: creditAccount, amountMinor: req.amountMinor },
      ];
    }

    const tx = await this.ledger.post({
      type,
      description: req.description,
      initiatedBy: req.userId,
      idempotencyKey: req.idempotencyKey,
      metadata: {
        ...req.metadata,
        charged: { amount: fromMinor(req.amountMinor, req.currency), currency: req.currency },
        ...(rate ? { rate } : {}),
      },
      legs,
    });
    // Si fue un reintento idempotente, devolvemos lo que realmente se debitó la primera vez.
    const debit = await this.entries.findOne({
      where: { transactionId: tx.id, userId: req.userId },
    });
    return {
      transactionId: tx.id,
      debitedMinor: debit ? Math.abs(debit.amountMinor) : debitedMinor,
      debitedCurrency: req.fundingCurrency,
      rate: (tx.metadata.rate as string | undefined) ?? null,
    };
  }

  async internalAccounts(userId: string): Promise<InternalAccount[]> {
    await this.ledger.ensureUserAccounts(userId);
    const list = await this.accounts.find({ where: { userId } });
    return SUPPORTED_CURRENCIES.map((c) => {
      const a = list.find((x) => x.currency === c)!;
      return { currency: c, balanceMinor: a.balanceMinor, balance: fromMinor(a.balanceMinor, c) };
    });
  }

  async previewCharge(req: Pick<ChargeRequest, 'amountMinor' | 'currency' | 'fundingCurrency'>) {
    if (!isCurrency(req.currency) || !isCurrency(req.fundingCurrency)) {
      throw new BadRequestException('Moneda no soportada');
    }
    if (req.currency === req.fundingCurrency) {
      return { debitedMinor: req.amountMinor, rate: null };
    }
    const conv = await this.fx.convertIn(req.fundingCurrency, req.currency, req.amountMinor);
    return { debitedMinor: conv.amountFromMinor, rate: conv.rate.toFixed(8) };
  }

  private quoteView(q: FxQuote) {
    return {
      quoteId: q.id,
      from: q.fromCurrency,
      to: q.toCurrency,
      amountFrom: fromMinor(q.amountFromMinor, q.fromCurrency),
      amountTo: fromMinor(q.amountToMinor, q.toCurrency),
      rate: q.rate,
      expiresAt: q.expiresAt,
    };
  }
}

function round(n: number) {
  return Number(n.toPrecision(8));
}

function counterparty(tx: WalletTransaction, userId: string): string | null {
  const m = tx.metadata as {
    from?: { id: string; name: string };
    to?: { id: string; name: string };
    merchantName?: string;
    payerName?: string;
  };
  if (tx.type === TransactionType.P2P_TRANSFER && m.from && m.to) {
    return m.from.id === userId ? m.to.name : m.from.name;
  }
  // El comercio ve quién le pagó; el cliente ve a qué comercio le pagó.
  if (m.payerName && tx.initiatedBy !== userId) return m.payerName;
  return m.merchantName ?? null;
}
