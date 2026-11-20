import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Account, FxQuote, LedgerEntry, WalletTransaction } from './entities';
import { FxService } from './fx.service';
import { LedgerService } from './ledger.service';
import { HealthController, InternalWalletController, WalletController } from './wallet.controller';
import { WalletAdminController } from './admin.controller';
import { WalletService } from './wallet.service';

const ENTITIES = [Account, WalletTransaction, LedgerEntry, FxQuote];

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
        database: config.get('WALLET_DB_NAME', 'wallet_db'),
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
  controllers: [WalletController, InternalWalletController, WalletAdminController, HealthController],
  providers: [LedgerService, FxService, WalletService],
})
export class AppModule {}
