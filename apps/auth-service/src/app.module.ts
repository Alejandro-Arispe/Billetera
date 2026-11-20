import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NOTIFICATION_CLIENT, QUEUES, rabbitUrl } from '@app/common';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { InternalController } from './auth/internal.controller';
import { AdminController } from './auth/admin.controller';
import { OtpService } from './auth/otp.service';
import { TokensService } from './auth/tokens.service';
import { OtpCode } from './entities/otp-code.entity';
import { RefreshToken } from './entities/refresh-token.entity';
import { User } from './entities/user.entity';
import { HealthController } from './health.controller';

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
        database: config.get('AUTH_DB_NAME', 'auth_db'),
        entities: [User, OtpCode, RefreshToken],
        // En desarrollo TypeORM crea las tablas solo. En producción se usarían migraciones.
        synchronize: config.get('DB_SYNC', 'true') === 'true',
      }),
    }),
    TypeOrmModule.forFeature([User, OtpCode, RefreshToken]),
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow('JWT_ACCESS_SECRET'),
      }),
    }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 60 }]),
    ClientsModule.register([
      {
        name: NOTIFICATION_CLIENT,
        transport: Transport.RMQ,
        options: {
          urls: [rabbitUrl()],
          queue: QUEUES.NOTIFICATIONS,
          queueOptions: { durable: true },
        },
      },
    ]),
  ],
  controllers: [AuthController, InternalController, AdminController, HealthController],
  providers: [AuthService, OtpService, TokensService, { provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
