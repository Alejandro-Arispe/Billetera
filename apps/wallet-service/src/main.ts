import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { setupHttpApp } from '@app/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  setupHttpApp(app, {
    title: 'Billetera · Wallet Service',
    description: 'Cuentas multimoneda, ledger de doble entrada, recargas, envíos P2P y cambio de divisas',
  });
  const port = Number(process.env.WALLET_PORT ?? 3002);
  await app.listen(port);
  Logger.log(`wallet-service escuchando en http://localhost:${port} (docs en /docs)`, 'Bootstrap');
}
bootstrap();
