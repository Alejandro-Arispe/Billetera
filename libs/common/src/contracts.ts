import { Currency } from './constants';

/** Contratos de las APIs internas entre servicios. */

export interface InternalUser {
  id: string;
  email: string;
  fullName: string;
  status: string;
  kycStatus: string;
  hasPin: boolean;
}

/** card-service / payments-service -> wallet-service: cobrar al usuario. */
export interface ChargeRequest {
  userId: string;
  /** Monto y moneda del comercio (lo que se cobra). */
  amountMinor: number;
  currency: Currency;
  /** Moneda de la cuenta de la que sale el dinero (la tarjeta es en USD). */
  fundingCurrency: Currency;
  type: 'CARD_PAYMENT' | 'QR_PAYMENT';
  description: string;
  idempotencyKey: string;
  /** Si se indica, el dinero se acredita en la billetera de este usuario (dueño del comercio). */
  creditUserId?: string;
  metadata?: Record<string, unknown>;
}

export interface InternalAccount {
  currency: Currency;
  balanceMinor: number;
  balance: string;
}

export interface ChargeResult {
  transactionId: string;
  debitedMinor: number;
  debitedCurrency: Currency;
  rate: string | null;
}
