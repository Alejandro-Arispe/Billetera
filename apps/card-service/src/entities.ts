import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { bigintTransformer, Currency } from '@app/common';

export enum CardStatus {
  ACTIVE = 'ACTIVE',
  FROZEN = 'FROZEN', // pausada por el usuario, se puede reactivar
  CANCELLED = 'CANCELLED', // dada de baja, definitivo
}

/**
 * Tarjeta virtual de débito (simulada) asociada al saldo en USD de la billetera.
 * El número y el CVV se guardan cifrados (AES-256-GCM). Para buscar la tarjeta al
 * autorizar un pago se usa un HMAC del número, nunca el número en claro.
 */
@Entity('cards')
export class Card {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ name: 'holder_name' })
  holderName!: string;

  @Column({ default: 'VISA' })
  brand!: string;

  @Column({ default: 'VIRTUAL' })
  type!: string;

  @Column({ name: 'pan_encrypted' })
  panEncrypted!: string;

  @Index({ unique: true })
  @Column({ name: 'pan_hash' })
  panHash!: string;

  @Column({ length: 4 })
  last4!: string;

  @Column({ name: 'exp_month' })
  expMonth!: number;

  @Column({ name: 'exp_year' })
  expYear!: number;

  @Column({ name: 'cvv_encrypted' })
  cvvEncrypted!: string;

  @Column({ type: 'enum', enum: CardStatus, default: CardStatus.ACTIVE })
  status!: CardStatus;

  /** Moneda de la tarjeta: se debita de la cuenta USD de la billetera. */
  @Column({ type: 'varchar', length: 3, default: 'USD' })
  currency!: Currency;

  @Column({ name: 'monthly_limit_minor', type: 'bigint', transformer: bigintTransformer })
  monthlyLimitMinor!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

export enum AuthorizationStatus {
  APPROVED = 'APPROVED',
  DECLINED = 'DECLINED',
}

/** Cada intento de compra con la tarjeta (aprobado o rechazado). */
@Entity('card_authorizations')
@Index(['cardId', 'createdAt'])
export class CardAuthorization {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'card_id', type: 'uuid' })
  cardId!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ type: 'enum', enum: AuthorizationStatus })
  status!: AuthorizationStatus;

  @Column({ name: 'decline_code', type: 'varchar', nullable: true })
  declineCode!: string | null;

  @Column({ name: 'amount_minor', type: 'bigint', transformer: bigintTransformer })
  amountMinor!: number;

  @Column({ type: 'varchar', length: 3 })
  currency!: Currency;

  /** Lo que efectivamente salió de la cuenta USD (puede diferir si el comercio cobra en otra moneda). */
  @Column({ name: 'debited_minor', type: 'bigint', nullable: true, transformer: bigintTransformer })
  debitedMinor!: number | null;

  @Column({ name: 'merchant_name' })
  merchantName!: string;

  @Column({ name: 'merchant_reference', type: 'varchar', length: 128 })
  merchantReference!: string;

  @Column({ name: 'approval_code', type: 'varchar', length: 6, nullable: true })
  approvalCode!: string | null;

  @Column({ name: 'wallet_transaction_id', type: 'uuid', nullable: true })
  walletTransactionId!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
