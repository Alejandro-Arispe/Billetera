import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { bigintTransformer, Currency } from '@app/common';

/**
 * Cuenta contable. Un usuario tiene una por moneda.
 * También existen cuentas del sistema (systemCode) que actúan como contrapartida:
 *   TOPUP_SOURCE    -> de donde sale el dinero de las recargas simuladas
 *   FX_POOL         -> mesa de cambio de divisas
 *   CARD_SETTLEMENT -> lo que se paga con tarjeta (se liquida a comercios)
 *   QR_SETTLEMENT   -> lo que se paga por QR (etapa 3)
 */
@Entity('accounts')
@Index(['userId', 'currency'], { unique: true, where: '"user_id" IS NOT NULL' })
@Index(['systemCode', 'currency'], { unique: true, where: '"system_code" IS NOT NULL' })
export class Account {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId!: string | null;

  @Column({ name: 'system_code', type: 'varchar', length: 32, nullable: true })
  systemCode!: string | null;

  @Column({ type: 'varchar', length: 3 })
  currency!: Currency;

  /** Saldo en unidades menores (centavos). Se mantiene junto con el ledger, en la misma transacción. */
  @Column({ name: 'balance_minor', type: 'bigint', default: 0, transformer: bigintTransformer })
  balanceMinor!: number;

  @Column({ name: 'allow_negative', default: false })
  allowNegative!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

export enum TransactionType {
  TOPUP = 'TOPUP',
  P2P_TRANSFER = 'P2P_TRANSFER',
  FX_CONVERSION = 'FX_CONVERSION',
  CARD_PAYMENT = 'CARD_PAYMENT',
  QR_PAYMENT = 'QR_PAYMENT',
  REFUND = 'REFUND',
}

/** Una operación de negocio. Agrupa 2 o más asientos que suman cero por moneda. */
@Entity('transactions')
export class WalletTransaction {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'enum', enum: TransactionType })
  type!: TransactionType;

  @Column({ default: 'COMPLETED' })
  status!: string;

  @Column()
  description!: string;

  /** Evita duplicados si el cliente reintenta (doble clic, timeout, etc.). */
  @Index({ unique: true, where: '"idempotency_key" IS NOT NULL' })
  @Column({ name: 'idempotency_key', type: 'varchar', length: 128, nullable: true })
  idempotencyKey!: string | null;

  @Column({ name: 'initiated_by', type: 'uuid', nullable: true })
  initiatedBy!: string | null;

  @Column({ type: 'jsonb', default: {} })
  metadata!: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

/** Asiento contable (doble entrada). Positivo = crédito a la cuenta, negativo = débito. Inmutable. */
@Entity('ledger_entries')
@Index(['userId', 'createdAt'])
export class LedgerEntry {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ name: 'transaction_id', type: 'uuid' })
  transactionId!: string;

  @Index()
  @Column({ name: 'account_id', type: 'uuid' })
  accountId!: string;

  /** Copia del dueño de la cuenta para consultar el historial rápido. */
  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId!: string | null;

  @Column({ type: 'varchar', length: 3 })
  currency!: Currency;

  @Column({ name: 'amount_minor', type: 'bigint', transformer: bigintTransformer })
  amountMinor!: number;

  @Column({ name: 'balance_after_minor', type: 'bigint', transformer: bigintTransformer })
  balanceAfterMinor!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

/** Cotización de cambio: congela la tasa por unos segundos para que el usuario la acepte. */
@Entity('fx_quotes')
export class FxQuote {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ name: 'from_currency', type: 'varchar', length: 3 })
  fromCurrency!: Currency;

  @Column({ name: 'to_currency', type: 'varchar', length: 3 })
  toCurrency!: Currency;

  @Column({ name: 'amount_from_minor', type: 'bigint', transformer: bigintTransformer })
  amountFromMinor!: number;

  @Column({ name: 'amount_to_minor', type: 'bigint', transformer: bigintTransformer })
  amountToMinor!: number;

  /** Tasa aplicada al cliente (ya incluye el margen). */
  @Column({ type: 'numeric', precision: 20, scale: 8 })
  rate!: string;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'used_at', type: 'timestamptz', nullable: true })
  usedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
