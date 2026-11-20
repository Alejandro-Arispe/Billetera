import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CardCrypto } from './card-crypto';
import { CardsController, HealthController } from './cards.controller';
import { CardsService } from './cards.service';
import { Card, CardAuthorization } from './entities';

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
        database: config.get('CARD_DB_NAME', 'card_db'),
        entities: [Card, CardAuthorization],
        synchronize: config.get('DB_SYNC', 'true') === 'true',
      }),
    }),
    TypeOrmModule.forFeature([Card, CardAuthorization]),
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({ secret: config.getOrThrow('JWT_ACCESS_SECRET') }),
    }),
  ],
  controllers: [CardsController, HealthController],
  providers: [CardsService, CardCrypto],
})
export class AppModule {}
