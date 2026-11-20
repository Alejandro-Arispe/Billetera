import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { setupHttpApp } from '@app/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.set('trust proxy', 1); // detrás del API gateway
  setupHttpApp(app, {
    title: 'Billetera · Auth Service',
    description: 'Registro, verificación de correo con OTP, login con 2FA por correo, sesiones y PIN de pagos',
  });
  const port = Number(process.env.AUTH_PORT ?? 3001);
  await app.listen(port);
  Logger.log(`auth-service escuchando en http://localhost:${port} (docs en /docs)`, 'Bootstrap');
}
bootstrap();
