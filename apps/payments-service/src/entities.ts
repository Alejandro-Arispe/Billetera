import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { bigintTransformer, Currency } from '@app/common';

/**
 * Comercio que cobra con la billetera (un POS, una tienda online, otro proyecto...).
 * Lo que cobra se acredita en la billetera de su dueño (ownerUserId).
 */
@Entity('merchants')
export class Merchant {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ name: 'owner_user_id', type: 'uuid' })
  ownerUserId!: string;

  @Column()
  name!: string;

  /** Hash SHA-256 de la API key secreta (la key solo se muestra una vez). */
  @Index({ unique: true })
  @Column({ name: 'api_key_hash' })
  apiKeyHash!: string;

  /** Primeros caracteres de la key, para reconocerla en el panel. */
  @Column({ name: 'api_key_prefix' })
  apiKeyPrefix!: string;

  @Column({ name: 'webhook_url', type: 'varchar', nullable: true })
  webhookUrl!: string | null;

  /** Secreto con el que se firman los webhooks (HMAC-SHA256). */
  @Column({ name: 'webhook_secret' })
  webhookSecret!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

export enum IntentStatus {
  CREATED = 'CREATED', // QR generado, esperando al cliente
  SCANNED = 'SCANNED', // el cliente abrió/escaneó el QR
  PROCESSING = 'PROCESSING', // cobro en curso (evita doble pago)
  PAID = 'PAID',
  EXPIRED = 'EXPIRED',
  CANCELLED = 'CANCELLED',
}

export const OPEN_STATUSES = [IntentStatus.CREATED, IntentStatus.SCANNED];

export interface IntentItem {
  name: string;
  quantity: number;
  unitPrice: string;
}

/** Intención de pago: "el comercio X quiere cobrar N". Es lo que viaja dentro del QR. */
@Entity('payment_intents')
@Index(['merchantId', 'reference'], { unique: true })
export class PaymentIntent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ name: 'merchant_id', type: 'uuid' })
  merchantId!: string;

  @Column({ name: 'amount_minor', type: 'bigint', transformer: bigintTransformer })
  amountMinor!: number;

  @Column({ type: 'varchar', length: 3 })
  currency!: Currency;

  @Column({ type: 'varchar', length: 140 })
  description!: string;

  /** Id de la orden en el sistema del comercio. Único por comercio. */
  @Column({ type: 'varchar', length: 64 })
  reference!: string;

  @Column({ type: 'jsonb', default: [] })
  items!: IntentItem[];

  @Index()
  @Column({ type: 'enum', enum: IntentStatus, default: IntentStatus.CREATED })
  status!: IntentStatus;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'payer_user_id', type: 'uuid', nullable: true })
  payerUserId!: string | null;

  @Column({ name: 'payer_name', type: 'varchar', nullable: true })
  payerName!: string | null;

  @Column({ name: 'scanned_at', type: 'timestamptz', nullable: true })
  scannedAt!: Date | null;

  @Column({ name: 'paid_at', type: 'timestamptz', nullable: true })
  paidAt!: Date | null;

  @Column({ name: 'wallet_transaction_id', type: 'uuid', nullable: true })
  walletTransactionId!: string | null;

  @Column({ name: 'debited_minor', type: 'bigint', nullable: true, transformer: bigintTransformer })
  debitedMinor!: number | null;

  @Column({ name: 'debited_currency', type: 'varchar', length: 3, nullable: true })
  debitedCurrency!: Currency | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

export enum DeliveryStatus {
  PENDING = 'PENDING',
  DELIVERED = 'DELIVERED',
  FAILED = 'FAILED', // se agotaron los reintentos
}

/** Cada webhook enviado (o por enviar) a un comercio, con sus reintentos. */
@Entity('webhook_deliveries')
@Index(['status', 'nextAttemptAt'])
export class WebhookDelivery {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'merchant_id', type: 'uuid' })
  merchantId!: string;

  @Column({ name: 'intent_id', type: 'uuid' })
  intentId!: string;

  @Column({ name: 'event_type' })
  eventType!: string;

  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Column({ type: 'enum', enum: DeliveryStatus, default: DeliveryStatus.PENDING })
  status!: DeliveryStatus;

  @Column({ default: 0 })
  attempts!: number;

  @Column({ name: 'last_status_code', type: 'int', nullable: true })
  lastStatusCode!: number | null;

  @Column({ name: 'last_error', type: 'varchar', nullable: true })
  lastError!: string | null;

  @Column({ name: 'next_attempt_at', type: 'timestamptz' })
  nextAttemptAt!: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
