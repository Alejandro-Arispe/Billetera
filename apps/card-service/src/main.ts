import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { setupHttpApp } from '@app/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  setupHttpApp(app, {
    title: 'Billetera · Card Service',
    description:
      'Tarjeta virtual de débito simulada: habilitar, ver datos, pausar, límites y autorización de compras',
  });
  const port = Number(process.env.CARD_PORT ?? 3004);
  await app.listen(port);
  Logger.log(`card-service escuchando en http://localhost:${port} (docs en /docs)`, 'Bootstrap');
}
bootstrap();
