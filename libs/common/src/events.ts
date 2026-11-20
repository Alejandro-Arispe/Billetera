/** Patrones de eventos que viajan por RabbitMQ entre servicios. */
export const EVENTS = {
  SEND_OTP_EMAIL: 'notification.email.otp',
  SEND_WELCOME_EMAIL: 'notification.email.welcome',
  SEND_KYC_RESULT_EMAIL: 'notification.email.kyc_result',
} as const;

export interface SendKycResultEmailEvent {
  to: string;
  fullName: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  reason?: string | null;
}

export type OtpPurpose = 'EMAIL_VERIFICATION' | 'LOGIN' | 'PIN_RESET';

export interface SendOtpEmailEvent {
  to: string;
  fullName: string;
  code: string;
  purpose: OtpPurpose;
  expiresInMinutes: number;
}

export interface SendWelcomeEmailEvent {
  to: string;
  fullName: string;
}
