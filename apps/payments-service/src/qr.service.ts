import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import * as QRCode from 'qrcode';
import { PaymentIntent } from './entities';

/**
 * Contenido del QR: una URL https/http normal, para que cualquier cámara de celular la abra
 * en la página de pago, y la app de la billetera la entienda igual:
 *
 *   {PAY_BASE_URL}/pay?i=<intentId>&s=<firma>
 *
 * La firma es un HMAC de (id, monto, moneda, comercio). Si alguien altera el QR o
 * fabrica uno propio, la firma no coincide y el pago se rechaza.
 */
@Injectable()
export class QrService {
  private readonly secret: string;
  private readonly baseUrl: string;

  constructor(config: ConfigService) {
    this.secret = config.getOrThrow('QR_SIGNING_SECRET');
    this.baseUrl = config.get('PAY_BASE_URL', 'http://localhost:4000').replace(/\/$/, '');
  }

  payload(intent: PaymentIntent): string {
    return `${this.baseUrl}/pay?i=${intent.id}&s=${this.sign(intent)}`;
  }

  async image(intent: PaymentIntent): Promise<string> {
    return QRCode.toDataURL(this.payload(intent), { errorCorrectionLevel: 'M', margin: 2, width: 320 });
  }

  /** Extrae id y firma del texto leído (URL completa o solo "i=...&s=..."). */
  parse(text: string): { intentId: string; signature: string } {
    const query = text.includes('?') ? text.slice(text.indexOf('?') + 1) : text;
    const params = new URLSearchParams(query.split('#')[0]);
    const intentId = params.get('i') ?? '';
    const signature = params.get('s') ?? '';
    if (!/^[0-9a-f-]{36}$/i.test(intentId) || !signature) {
      throw new BadRequestException('Este QR no es un cobro de la billetera');
    }
    return { intentId, signature };
  }

  verify(intent: PaymentIntent, signature: string): void {
    const expected = Buffer.from(this.sign(intent));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      throw new BadRequestException('QR inválido o alterado');
    }
  }

  private sign(i: PaymentIntent): string {
    return createHmac('sha256', this.secret)
      .update(`${i.id}|${i.amountMinor}|${i.currency}|${i.merchantId}`)
      .digest('base64url')
      .slice(0, 22);
  }
}
