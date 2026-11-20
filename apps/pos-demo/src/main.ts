import { Logger, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { PosController } from './pos.controller';
import { PosService } from './pos.service';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env'] })],
  controllers: [PosController],
  providers: [PosService],
})
class PosModule {}

async function bootstrap() {
  // rawBody: necesario para verificar la firma de los webhooks sobre el cuerpo exacto recibido.
  const app = await NestFactory.create<NestExpressApplication>(PosModule, { rawBody: true });
  app.useStaticAssets(process.env.POS_PUBLIC_DIR ?? join(process.cwd(), 'apps', 'pos-demo', 'public'));
  const port = Number(process.env.POS_PORT ?? 5000);
  await app.listen(port);
  const pos = app.get(PosService);
  Logger.log(`POS demo en http://localhost:${port}`, 'Bootstrap');
  if (!pos.configured) Logger.warn('POS sin API key: ejecuta "npm run pos:setup"', 'Bootstrap');
}
bootstrap();
