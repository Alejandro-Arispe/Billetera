import { INestApplication, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';

/** Configuración HTTP común: seguridad, validación de DTOs y documentación Swagger en /docs. */
export function setupHttpApp(app: INestApplication, opts: { title: string; description: string }) {
  app.use(helmet());
  app.enableCors({ origin: true, credentials: true });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );

  const config = new DocumentBuilder()
    .setTitle(opts.title)
    .setDescription(opts.description)
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));
}

export function rabbitUrl(): string {
  return process.env.RABBITMQ_URL ?? 'amqp://billetera:billetera@localhost:5672';
}
