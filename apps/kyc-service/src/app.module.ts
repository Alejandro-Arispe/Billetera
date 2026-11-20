import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NOTIFICATION_CLIENT, QUEUES, rabbitUrl } from '@app/common';
import { HealthController, KycAdminController, KycController } from './controllers';
import { KycSubmission } from './entities';
import { KycService } from './kyc.service';
import { VaultService } from './vault.service';

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
        database: config.get('KYC_DB_NAME', 'kyc_db'),
        entities: [KycSubmission],
        synchronize: config.get('DB_SYNC', 'true') === 'true',
      }),
    }),
    TypeOrmModule.forFeature([KycSubmission]),
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({ secret: config.getOrThrow('JWT_ACCESS_SECRET') }),
    }),
    ClientsModule.register([
      {
        name: NOTIFICATION_CLIENT,
        transport: Transport.RMQ,
        options: { urls: [rabbitUrl()], queue: QUEUES.NOTIFICATIONS, queueOptions: { durable: true } },
      },
    ]),
  ],
  controllers: [KycController, KycAdminController, HealthController],
  providers: [KycService, VaultService],
})
export class AppModule {}
