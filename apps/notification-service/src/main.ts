import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { QUEUES, rabbitUrl } from '@app/common';
import { AppModule } from './app.module';

/** App híbrida: consume la cola de RabbitMQ y expone /health por HTTP. */
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.RMQ,
    options: {
      urls: [rabbitUrl()],
      queue: QUEUES.NOTIFICATIONS,
      queueOptions: { durable: true },
    },
  });
  await app.startAllMicroservices();
  const port = Number(process.env.NOTIFICATION_PORT ?? 3006);
  await app.listen(port);
  Logger.log(`notification-service escuchando la cola "${QUEUES.NOTIFICATIONS}" (health en :${port})`, 'Bootstrap');
}
bootstrap();
