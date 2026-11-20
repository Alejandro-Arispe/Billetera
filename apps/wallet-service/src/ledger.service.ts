import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  OnModuleInit,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import { Currency, SUPPORTED_CURRENCIES } from '@app/common';
import { Account, LedgerEntry, TransactionType, WalletTransaction } from './entities';

export type SystemCode = 'TOPUP_SOURCE' | 'FX_POOL' | 'CARD_SETTLEMENT' | 'QR_SETTLEMENT';
const SYSTEM_CODES: SystemCode[] = ['TOPUP_SOURCE', 'FX_POOL', 'CARD_SETTLEMENT', 'QR_SETTLEMENT'];

export type AccountRef = { userId: string; currency: Currency } | { system: SystemCode; currency: Currency };

export interface Leg {
  account: AccountRef;
  amountMinor: number; // + crédito, - débito
}

export interface PostRequest {
  type: TransactionType;
  description: string;
  initiatedBy: string | null;
  idempotencyKey?: string | null;
  metadata?: Record<string, unknown>;
  legs: Leg[];
}

/**
 * Motor contable de doble entrada. Toda operación de dinero pasa por post():
 *  1. Las patas deben sumar 0 en cada moneda (el dinero no se crea ni se destruye).
 *  2. Se bloquean las cuentas involucradas (SELECT ... FOR UPDATE) en orden fijo
 *     para que dos pagos simultáneos no gasten el mismo saldo ni se bloqueen entre sí.
 *  3. Una cuenta de usuario nunca queda en negativo.
 *  4. Todo ocurre en una sola transacción de base de datos: o se aplica entero o nada.
 */
@Injectable()
export class LedgerService implements OnModuleInit {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  async onModuleInit() {
    for (const code of SYSTEM_CODES) {
      for (const currency of SUPPORTED_CURRENCIES) {
        await this.db
          .createQueryBuilder()
          .insert()
          .into(Account)
          .values({ systemCode: code, currency, allowNegative: true })
          .orIgnore()
          .execute();
      }
    }
  }

  /** Crea (si faltan) las cuentas del usuario en todas las monedas. */
  async ensureUserAccounts(userId: string, manager: EntityManager = this.db.manager) {
    await manager
      .createQueryBuilder()
      .insert()
      .into(Account)
      .values(SUPPORTED_CURRENCIES.map((currency) => ({ userId, currency })))
      .orIgnore()
      .execute();
  }

  async post(req: PostRequest): Promise<WalletTransaction> {
    if (req.idempotencyKey) {
      const existing = await this.db
        .getRepository(WalletTransaction)
        .findOne({ where: { idempotencyKey: req.idempotencyKey } });
      if (existing) return existing;
    }

    const sums = new Map<Currency, number>();
    for (const leg of req.legs) {
      if (!Number.isSafeInteger(leg.amountMinor) || leg.amountMinor === 0) {
        throw new BadRequestException('Monto inválido');
      }
      sums.set(leg.account.currency, (sums.get(leg.account.currency) ?? 0) + leg.amountMinor);
    }
    if ([...sums.values()].some((s) => s !== 0)) {
      throw new InternalServerErrorException('Asiento descuadrado: las patas no suman cero');
    }

    try {
      return await this.db.transaction(async (m) => {
        const userIds = [...new Set(req.legs.flatMap((l) => ('userId' in l.account ? [l.account.userId] : [])))];
        for (const id of userIds) await this.ensureUserAccounts(id, m);

        const accounts = await Promise.all(req.legs.map((l) => this.find(m, l.account)));
        const ids = [...new Set(accounts.map((a) => a.id))].sort();
        const locked = await m.getRepository(Account).find({
          where: { id: In(ids) },
          order: { id: 'ASC' },
          lock: { mode: 'pessimistic_write' },
        });
        const byId = new Map(locked.map((a) => [a.id, a]));

        const tx = await m.getRepository(WalletTransaction).save(
          m.getRepository(WalletTransaction).create({
            type: req.type,
            description: req.description,
            initiatedBy: req.initiatedBy,
            idempotencyKey: req.idempotencyKey ?? null,
            metadata: req.metadata ?? {},
          }),
        );

        const entries: LedgerEntry[] = [];
        req.legs.forEach((leg, i) => {
          const account = byId.get(accounts[i].id)!;
          const next = account.balanceMinor + leg.amountMinor;
          if (next < 0 && !account.allowNegative) {
            throw new UnprocessableEntityException({
              statusCode: 422,
              code: 'INSUFFICIENT_FUNDS',
              message: `Saldo insuficiente en ${account.currency}`,
            });
          }
          account.balanceMinor = next;
          entries.push(
            m.getRepository(LedgerEntry).create({
              transactionId: tx.id,
              accountId: account.id,
              userId: account.userId,
              currency: account.currency,
              amountMinor: leg.amountMinor,
              balanceAfterMinor: next,
            }),
          );
        });

        await m.getRepository(Account).save([...byId.values()]);
        await m.getRepository(LedgerEntry).save(entries);
        return tx;
      });
    } catch (err) {
      // Dos requests con la misma clave al mismo tiempo: gana uno, el otro devuelve el mismo resultado.
      if (req.idempotencyKey && (err as { code?: string }).code === '23505') {
        const existing = await this.db
          .getRepository(WalletTransaction)
          .findOne({ where: { idempotencyKey: req.idempotencyKey } });
        if (existing) return existing;
      }
      throw err;
    }
  }

  private async find(m: EntityManager, ref: AccountRef): Promise<Account> {
    const where =
      'userId' in ref
        ? { userId: ref.userId, currency: ref.currency }
        : { systemCode: ref.system, currency: ref.currency };
    return m.getRepository(Account).findOneOrFail({ where });
  }

  /** Auditoría: el ledger entero debe sumar 0 por moneda y cada saldo debe coincidir con sus asientos. */
  async audit() {
    const totals: { currency: string; total: string }[] = await this.db.query(
      `SELECT currency, SUM(amount_minor)::text AS total FROM ledger_entries GROUP BY currency`,
    );
    const mismatched: { id: string }[] = await this.db.query(
      `SELECT a.id FROM accounts a
         LEFT JOIN ledger_entries e ON e.account_id = a.id
        GROUP BY a.id, a.balance_minor
       HAVING a.balance_minor <> COALESCE(SUM(e.amount_minor), 0)`,
    );
    const balanced = totals.every((t) => t.total === '0') && mismatched.length === 0;
    return { balanced, totalsByCurrency: totals, accountsWithMismatch: mismatched.map((r) => r.id) };
  }
}
