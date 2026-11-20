import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { setupHttpApp } from '@app/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  setupHttpApp(app, {
    title: 'Billetera · KYC Service',
    description:
      'Verificación de identidad: datos personales, foto del documento y selfie, verificaciones automáticas ' +
      'y revisión manual por un administrador.',
  });
  const port = Number(process.env.KYC_PORT ?? 3005);
  await app.listen(port);
  Logger.log(`kyc-service escuchando en http://localhost:${port} (docs en /docs)`, 'Bootstrap');
}
bootstrap();
