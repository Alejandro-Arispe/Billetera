import { BadRequestException, HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { createHmac, randomInt, timingSafeEqual } from 'crypto';
import { IsNull, MoreThan, Repository } from 'typeorm';
import { EVENTS, NOTIFICATION_CLIENT, OtpPurpose, SendOtpEmailEvent } from '@app/common';
import { OtpCode } from '../entities/otp-code.entity';
import { User } from '../entities/user.entity';

const MAX_ATTEMPTS = 5;

/**
 * Genera, envía (vía notification-service) y valida códigos OTP de 6 dígitos.
 * - El código nunca se guarda en claro: se guarda un HMAC.
 * - Vence a los OTP_TTL_MINUTES, admite 5 intentos y es de un solo uso.
 * - Hay un tiempo de espera entre reenvíos para evitar spam.
 */
@Injectable()
export class OtpService {
  private readonly ttlMinutes: number;
  private readonly cooldownSeconds: number;
  private readonly secret: string;

  constructor(
    @InjectRepository(OtpCode) private readonly otps: Repository<OtpCode>,
    @Inject(NOTIFICATION_CLIENT) private readonly notifications: ClientProxy,
    config: ConfigService,
  ) {
    this.ttlMinutes = Number(config.get('OTP_TTL_MINUTES', 10));
    this.cooldownSeconds = Number(config.get('OTP_RESEND_COOLDOWN_SECONDS', 60));
    this.secret = config.getOrThrow('OTP_SECRET');
  }

  /** Crea un OTP nuevo (invalida los anteriores del mismo propósito) y lo envía por correo. */
  async issue(user: User, purpose: OtpPurpose): Promise<OtpCode> {
    const recent = await this.otps.findOne({
      where: {
        userId: user.id,
        purpose,
        createdAt: MoreThan(new Date(Date.now() - this.cooldownSeconds * 1000)),
      },
      order: { createdAt: 'DESC' },
    });
    if (recent) {
      throw new HttpException(
        `Espera ${this.cooldownSeconds} segundos antes de pedir otro código`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    await this.otps.update(
      { userId: user.id, purpose, consumedAt: IsNull() },
      { consumedAt: new Date() },
    );

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const otp = await this.otps.save(
      this.otps.create({
        userId: user.id,
        purpose,
        codeHash: this.hash(code),
        expiresAt: new Date(Date.now() + this.ttlMinutes * 60_000),
      }),
    );

    const event: SendOtpEmailEvent = {
      to: user.email,
      fullName: user.fullName,
      code,
      purpose,
      expiresInMinutes: this.ttlMinutes,
    };
    this.notifications.emit(EVENTS.SEND_OTP_EMAIL, event);
    return otp;
  }

  /** Valida el código del último OTP vigente. Lanza error si no es válido. */
  async verifyLatest(userId: string, purpose: OtpPurpose, code: string): Promise<void> {
    const otp = await this.otps.findOne({
      where: { userId, purpose, consumedAt: IsNull() },
      order: { createdAt: 'DESC' },
    });
    await this.consume(otp, code);
  }

  /** Valida un OTP concreto (por id, usado como challengeId del login). */
  async verifyById(id: string, purpose: OtpPurpose, code: string): Promise<OtpCode> {
    const otp = await this.otps.findOne({ where: { id, purpose } });
    await this.consume(otp, code);
    return otp!;
  }

  private async consume(otp: OtpCode | null, code: string): Promise<void> {
    if (!otp || otp.consumedAt) {
      throw new BadRequestException('Código inválido o ya utilizado. Solicita uno nuevo.');
    }
    if (otp.expiresAt < new Date()) {
      throw new BadRequestException('El código expiró. Solicita uno nuevo.');
    }
    if (otp.attempts >= MAX_ATTEMPTS) {
      throw new BadRequestException('Demasiados intentos. Solicita un código nuevo.');
    }

    const ok = timingSafeEqual(Buffer.from(this.hash(code)), Buffer.from(otp.codeHash));
    if (!ok) {
      await this.otps.increment({ id: otp.id }, 'attempts', 1);
      const left = MAX_ATTEMPTS - otp.attempts - 1;
      throw new BadRequestException(`Código incorrecto. Te quedan ${left} intento(s).`);
    }
    await this.otps.update({ id: otp.id }, { consumedAt: new Date() });
  }

  private hash(code: string): string {
    return createHmac('sha256', this.secret).update(code).digest('hex');
  }
}
