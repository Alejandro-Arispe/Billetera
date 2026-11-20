/** Nombres de colas RabbitMQ (una cola por servicio consumidor). */
export const QUEUES = {
  NOTIFICATIONS: 'notifications_queue',
} as const;

/** Tokens de inyección para clientes de microservicios. */
export const NOTIFICATION_CLIENT = 'NOTIFICATION_CLIENT';

/** Monedas soportadas por la billetera (ISO 4217). Se amplía en la etapa 2. */
export const SUPPORTED_CURRENCIES = ['BOB', 'USD', 'EUR'] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

export enum UserRole {
  USER = 'USER',
  MERCHANT = 'MERCHANT',
  ADMIN = 'ADMIN',
}
