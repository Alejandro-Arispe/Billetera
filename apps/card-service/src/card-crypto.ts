import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomInt } from 'crypto';

/** Cifrado de datos sensibles de la tarjeta y generación de números válidos (Luhn). */
@Injectable()
export class CardCrypto {
  private readonly key: Buffer;
  readonly bin: string;

  constructor(config: ConfigService) {
    const hex = config.getOrThrow<string>('CARD_ENCRYPTION_KEY');
    this.key = Buffer.from(hex, 'hex');
    if (this.key.length !== 32) throw new Error('CARD_ENCRYPTION_KEY debe tener 64 caracteres hex (32 bytes)');
    this.bin = config.get('CARD_BIN', '40000012');
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
  }

  decrypt(payload: string): string {
    const [iv, tag, data] = payload.split('.').map((p) => Buffer.from(p, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  }

  /** Huella del número de tarjeta para poder buscarla sin guardarla en claro. */
  panHash(pan: string): string {
    return createHmac('sha256', this.key).update(`pan:${pan}`).digest('hex');
  }

  /** Número de 16 dígitos = BIN del emisor simulado + aleatorios + dígito verificador Luhn. */
  generatePan(): string {
    let body = this.bin;
    while (body.length < 15) body += randomInt(0, 10).toString();
    return body + luhnCheckDigit(body);
  }

  generateCvv(): string {
    return randomInt(0, 1000).toString().padStart(3, '0');
  }
}

export function luhnCheckDigit(partial: string): string {
  let sum = 0;
  for (let i = 0; i < partial.length; i++) {
    let d = Number(partial[partial.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return ((10 - (sum % 10)) % 10).toString();
}

export function isLuhnValid(pan: string): boolean {
  return /^\d{13,19}$/.test(pan) && luhnCheckDigit(pan.slice(0, -1)) === pan.slice(-1);
}
