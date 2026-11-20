import { Controller, Get, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { EVENTS, SendKycResultEmailEvent, SendOtpEmailEvent, SendWelcomeEmailEvent } from '@app/common';
import { MailService } from './mail.service';

/** Consume eventos de RabbitMQ y los convierte en correos. */
@Controller()
export class NotificationController {
  private readonly logger = new Logger(NotificationController.name);

  constructor(private readonly mail: MailService) {}

  @EventPattern(EVENTS.SEND_OTP_EMAIL)
  async onOtp(@Payload() e: SendOtpEmailEvent) {
    try {
      await this.mail.sendOtp(e.to, e.fullName, e.code, e.purpose, e.expiresInMinutes);
    } catch (err) {
      this.logger.error(`No se pudo enviar el OTP a ${e.to}: ${(err as Error).message}`);
    }
  }

  @EventPattern(EVENTS.SEND_WELCOME_EMAIL)
  async onWelcome(@Payload() e: SendWelcomeEmailEvent) {
    try {
      await this.mail.sendWelcome(e.to, e.fullName);
    } catch (err) {
      this.logger.error(`No se pudo enviar la bienvenida a ${e.to}: ${(err as Error).message}`);
    }
  }

  @EventPattern(EVENTS.SEND_KYC_RESULT_EMAIL)
  async onKyc(@Payload() e: SendKycResultEmailEvent) {
    try {
      await this.mail.sendKycResult(e.to, e.fullName, e.status, e.reason ?? null);
    } catch (err) {
      this.logger.error(`No se pudo enviar el resultado KYC a ${e.to}: ${(err as Error).message}`);
    }
  }

  @Get('health')
  health() {
    return { service: 'notification-service', status: 'ok' };
  }
}
