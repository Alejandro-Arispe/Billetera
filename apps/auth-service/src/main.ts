import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { setupHttpApp } from '@app/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Saltos de proxy delante del servicio: 1 = API gateway; 2 = HTTPS (Caddy) + gateway en producción.
  app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 1));
  setupHttpApp(app, {
    title: 'Billetera · Auth Service',
    description: 'Registro, verificación de correo con OTP, login, sesiones y PIN de pagos',
  });
  const port = Number(process.env.AUTH_PORT ?? 3001);
  await app.listen(port);
  Logger.log(`auth-service escuchando en http://localhost:${port} (docs en /docs)`, 'Bootstrap');
}
bootstrap();
