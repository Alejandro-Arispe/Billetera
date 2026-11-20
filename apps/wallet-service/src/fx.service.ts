import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CURRENCY_DECIMALS, Currency, SUPPORTED_CURRENCIES } from '@app/common';

/** Tasas de respaldo (1 USD = X) si la API externa no responde. Solo para seguir funcionando offline. */
const FALLBACK_RATES: Record<Currency, number> = { BOB: 6.91, USD: 1, EUR: 0.86 };
const CACHE_MS = 60 * 60 * 1000;

export interface RatesSnapshot {
  base: 'USD';
  source: string;
  fetchedAt: string;
  rates: Record<Currency, number>;
}

/**
 * Tipos de cambio reales desde una API pública gratuita (open.er-api.com, sin API key),
 * cacheados 1 hora. Al cliente se le aplica un margen (spread), como hacen las billeteras reales.
 */
@Injectable()
export class FxService {
  private readonly logger = new Logger(FxService.name);
  private cache: RatesSnapshot | null = null;
  private cacheUntil = 0;
  readonly spread: number;
  private readonly url: string;

  constructor(config: ConfigService) {
    this.spread = Number(config.get('FX_SPREAD', 0.015));
    this.url = config.get('FX_RATES_URL', 'https://open.er-api.com/v6/latest/USD');
  }

  async snapshot(): Promise<RatesSnapshot> {
    if (this.cache && Date.now() < this.cacheUntil) return this.cache;
    try {
      const res = await fetch(this.url, { signal: AbortSignal.timeout(5000) });
      const body = (await res.json()) as { result?: string; rates?: Record<string, number> };
      if (body.result !== 'success' || !body.rates) throw new Error('respuesta inesperada');
      const rates = {} as Record<Currency, number>;
      for (const c of SUPPORTED_CURRENCIES) {
        if (!body.rates[c]) throw new Error(`falta la moneda ${c}`);
        rates[c] = body.rates[c];
      }
      this.cache = { base: 'USD', source: 'open.er-api.com', fetchedAt: new Date().toISOString(), rates };
      this.cacheUntil = Date.now() + CACHE_MS;
    } catch (err) {
      this.logger.warn(`No se pudieron obtener tasas reales (${(err as Error).message}); uso respaldo`);
      this.cache = { base: 'USD', source: 'fallback', fetchedAt: new Date().toISOString(), rates: FALLBACK_RATES };
      this.cacheUntil = Date.now() + 5 * 60 * 1000; // reintenta en 5 min
    }
    return this.cache;
  }

  /** Tasa media de mercado: cuántas unidades de `to` vale 1 unidad de `from`. */
  async midRate(from: Currency, to: Currency): Promise<number> {
    const { rates } = await this.snapshot();
    return rates[to] / rates[from];
  }

  /** Tasa que recibe el cliente al vender `from` y comprar `to` (con margen). */
  async customerRate(from: Currency, to: Currency): Promise<number> {
    if (from === to) throw new BadRequestException('Las monedas deben ser distintas');
    return (await this.midRate(from, to)) * (1 - this.spread);
  }

  /** Cuánto recibe el cliente en `to` por vender `amountFromMinor` de `from` (redondeo a favor de la casa). */
  async convertOut(from: Currency, to: Currency, amountFromMinor: number) {
    const rate = await this.customerRate(from, to);
    const factor = 10 ** (CURRENCY_DECIMALS[to] - CURRENCY_DECIMALS[from]);
    return { rate, amountToMinor: Math.floor(amountFromMinor * rate * factor) };
  }

  /** Cuánto hay que debitar de `from` para pagar exactamente `amountToMinor` en `to`. */
  async convertIn(from: Currency, to: Currency, amountToMinor: number) {
    const rate = await this.customerRate(from, to);
    const factor = 10 ** (CURRENCY_DECIMALS[to] - CURRENCY_DECIMALS[from]);
    return { rate, amountFromMinor: Math.ceil(amountToMinor / (rate * factor)) };
  }
}
