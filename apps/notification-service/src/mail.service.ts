import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { OtpPurpose } from '@app/common';

const SUBJECTS: Record<OtpPurpose, string> = {
  EMAIL_VERIFICATION: 'Verifica tu correo',
  LOGIN: 'Tu código de acceso',
  PIN_RESET: 'Código para restablecer tu PIN',
};

const INTROS: Record<OtpPurpose, string> = {
  EMAIL_VERIFICATION: 'Usa este código para activar tu cuenta:',
  LOGIN: 'Alguien (esperamos que tú) está iniciando sesión. Tu código es:',
  PIN_RESET: 'Usa este código para restablecer tu PIN de pagos:',
};

/** Envía correos por SMTP. En desarrollo apunta a Mailpit (http://localhost:8025). */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: nodemailer.Transporter;
  private readonly from: string;
  private readonly appName: string;

  constructor(config: ConfigService) {
    this.appName = config.get('APP_NAME', 'Billetera');
    this.from = config.get('MAIL_FROM', `${this.appName} <no-reply@billetera.local>`);
    const user = config.get<string>('SMTP_USER');
    this.transporter = nodemailer.createTransport({
      host: config.get('SMTP_HOST', 'localhost'),
      port: Number(config.get('SMTP_PORT', 1025)),
      secure: config.get('SMTP_SECURE', 'false') === 'true',
      auth: user ? { user, pass: config.get('SMTP_PASSWORD') } : undefined,
    });
  }

  async sendOtp(to: string, fullName: string, code: string, purpose: OtpPurpose, minutes: number) {
    const body = `
      <p>Hola ${escapeHtml(firstName(fullName))},</p>
      <p>${INTROS[purpose]}</p>
      <p style="font-size:32px;letter-spacing:8px;font-weight:700;margin:24px 0;color:#111">${code}</p>
      <p style="color:#555">Vence en ${minutes} minutos. No lo compartas con nadie:
      nuestro equipo nunca te lo va a pedir.</p>`;
    await this.send(to, `${code} · ${SUBJECTS[purpose]}`, body,
      `${INTROS[purpose]} ${code} (vence en ${minutes} minutos)`);
  }

  async sendWelcome(to: string, fullName: string) {
    const body = `
      <p>Hola ${escapeHtml(firstName(fullName))}, ¡tu cuenta ya está activa!</p>
      <p>Siguientes pasos: configura tu PIN de pagos y verifica tu identidad para
      activar tu tarjeta virtual.</p>`;
    await this.send(to, `Bienvenido a ${this.appName}`, body, 'Tu cuenta ya está activa.');
  }

  async sendKycResult(to: string, fullName: string, status: string, reason: string | null) {
    const name = escapeHtml(firstName(fullName));
    const content: Record<string, [string, string]> = {
      PENDING: [
        'Recibimos tus documentos',
        `<p>Hola ${name}, recibimos tus datos y documentos. Los revisaremos en breve y te avisaremos por este medio.</p>`,
      ],
      APPROVED: [
        'Tu identidad fue verificada',
        `<p>Hola ${name}, ¡tu identidad fue verificada! Ya puedes habilitar tu tarjeta virtual en el apartado
         <strong>Tarjetas</strong> y usar todas las funciones de la billetera.</p>`,
      ],
      REJECTED: [
        'No pudimos verificar tu identidad',
        `<p>Hola ${name}, no pudimos verificar tu identidad.</p>
         <p><strong>Motivo:</strong> ${escapeHtml(reason ?? 'sin detalle')}</p>
         <p>Puedes corregir los datos y volver a enviar tus documentos desde la app.</p>`,
      ],
    };
    const [subject, body] = content[status] ?? content.PENDING;
    await this.send(to, subject, body, subject);
  }

  private async send(to: string, subject: string, htmlBody: string, text: string) {
    const html = `
      <div style="font-family:Segoe UI,Arial,sans-serif;max-width:480px;margin:auto;padding:24px;border:1px solid #eee;border-radius:12px">
        <h2 style="margin-top:0;color:#4f46e5">${this.appName}</h2>
        ${htmlBody}
      </div>`;
    await this.transporter.sendMail({ from: this.from, to, subject, html, text });
    this.logger.log(`Correo "${subject.replace(/^\d{6}/, '******')}" enviado a ${to}`);
  }
}

const firstName = (full: string) => full.split(' ')[0];
const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
