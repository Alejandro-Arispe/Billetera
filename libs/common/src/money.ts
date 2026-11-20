import { BadRequestException } from '@nestjs/common';
import { Currency, SUPPORTED_CURRENCIES } from './constants';

/**
 * El dinero NUNCA se maneja con decimales de punto flotante.
 * Internamente todo va en "unidades menores" enteras (centavos).
 * La API recibe y devuelve montos como string con 2 decimales: "12.50".
 */
export const CURRENCY_DECIMALS: Record<Currency, number> = { BOB: 2, USD: 2, EUR: 2 };

export const AMOUNT_REGEX = /^\d{1,12}(\.\d{1,2})?$/;

export function isCurrency(value: string): value is Currency {
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(value);
}

/** "12.5" USD -> 1250 */
export function toMinor(amount: string, currency: Currency): number {
  if (!AMOUNT_REGEX.test(amount)) throw new BadRequestException(`Monto inválido: ${amount}`);
  const decimals = CURRENCY_DECIMALS[currency] ?? 2; // monedas retiradas (datos viejos) usan 2
  const [int, frac = ''] = amount.split('.');
  const minor = Number(int) * 10 ** decimals + Number(frac.padEnd(decimals, '0'));
  if (!Number.isSafeInteger(minor)) throw new BadRequestException('Monto fuera de rango');
  return minor;
}

/** 1250 USD -> "12.50" */
export function fromMinor(minor: number, currency: Currency): string {
  const decimals = CURRENCY_DECIMALS[currency] ?? 2; // monedas retiradas (datos viejos) usan 2
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const int = Math.floor(abs / 10 ** decimals);
  const frac = (abs % 10 ** decimals).toString().padStart(decimals, '0');
  return `${sign}${int}.${frac}`;
}

/** Transformer de TypeORM: columnas bigint de Postgres llegan como string. */
export const bigintTransformer = {
  to: (v: number | null) => v,
  from: (v: string | null) => (v === null ? null : Number(v)),
};
