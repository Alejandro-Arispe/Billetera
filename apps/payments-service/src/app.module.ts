import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HealthController, IntentsController, MerchantsController, PayController, PaymentsAdminController } from './controllers';
import { Merchant, PaymentIntent, WebhookDelivery } from './entities';
import { IntentsService } from './intents.service';
import { MerchantKeyGuard } from './merchant-key.guard';
import { MerchantsService } from './merchants.service';
import { QrService } from './qr.service';
import { WebhooksService } from './webhooks.service';

const ENTITIES = [Merchant, PaymentIntent, WebhookDelivery];

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env'] }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get('DB_HOST', 'localhost'),
        port: Number(config.get('DB_PORT', 5434)),
        username: config.get('DB_USER', 'billetera'),
        password: config.get('DB_PASSWORD', 'billetera'),
        database: config.get('PAYMENTS_DB_NAME', 'payments_db'),
        entities: ENTITIES,
        synchronize: config.get('DB_SYNC', 'true') === 'true',
      }),
    }),
    TypeOrmModule.forFeature(ENTITIES),
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({ secret: config.getOrThrow('JWT_ACCESS_SECRET') }),
    }),
  ],
  controllers: [MerchantsController, IntentsController, PayController, PaymentsAdminController, HealthController],
  providers: [MerchantsService, IntentsService, QrService, WebhooksService, MerchantKeyGuard],
})
export class AppModule {}
