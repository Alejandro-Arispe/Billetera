import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { setupHttpApp } from '@app/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  setupHttpApp(app, {
    title: 'Billetera · Payments Service',
    description:
      'Pasarela de cobros QR para POS y otros proyectos: comercios con API key, cobros (payment intents) ' +
      'con QR firmado, pago desde la billetera y webhooks firmados.',
  });
  const port = Number(process.env.PAYMENTS_PORT ?? 3003);
  await app.listen(port);
  Logger.log(`payments-service escuchando en http://localhost:${port} (docs en /docs)`, 'Bootstrap');
}
bootstrap();
