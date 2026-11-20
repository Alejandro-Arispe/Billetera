import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ChargeRequest, CurrentUser, InternalKeyGuard, JwtAuthGuard, JwtPayload } from '@app/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import { DataSource } from 'typeorm';
import { FxConvertDto, FxQuoteDto, HistoryQueryDto, TopupDto, TransferDto } from './dto';
import { LedgerService } from './ledger.service';
import { WalletService } from './wallet.service';

@ApiTags('wallet')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('wallet')
export class WalletController {
  constructor(private readonly wallet: WalletService) {}

  @Get('accounts')
  @ApiOperation({ summary: 'Saldos por moneda (crea las cuentas la primera vez)' })
  balances(@CurrentUser() u: JwtPayload) {
    return this.wallet.balances(u.sub);
  }

  @Post('topups')
  @ApiOperation({ summary: 'Recarga simulada de saldo' })
  topup(@CurrentUser() u: JwtPayload, @Body() dto: TopupDto) {
    return this.wallet.topup(u.sub, dto);
  }

  @Post('transfers')
  @ApiOperation({ summary: 'Enviar dinero a otro usuario por correo (requiere PIN)' })
  @ApiHeader({ name: 'Idempotency-Key', required: false, description: 'Evita envíos duplicados al reintentar' })
  transfer(
    @CurrentUser() u: JwtPayload,
    @Body() dto: TransferDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.wallet.transfer(u.sub, dto, key?.slice(0, 64));
  }

  @Get('transactions')
  @ApiOperation({ summary: 'Historial de movimientos' })
  history(@CurrentUser() u: JwtPayload, @Query() q: HistoryQueryDto) {
    return this.wallet.history(u.sub, q);
  }

  @Get('transactions/:id')
  @ApiOperation({ summary: 'Comprobante de una transacción' })
  receipt(@CurrentUser() u: JwtPayload, @Param('id', ParseUUIDPipe) id: string) {
    return this.wallet.receipt(id, u.sub);
  }

  @Get('fx/rates')
  @ApiOperation({ summary: 'Tipos de cambio reales (mercado y cliente)' })
  rates() {
    return this.wallet.rates();
  }

  @Post('fx/quotes')
  @ApiOperation({ summary: 'Cotizar un cambio de moneda (válido 30 s)' })
  quote(@CurrentUser() u: JwtPayload, @Body() dto: FxQuoteDto) {
    return this.wallet.quote(u.sub, dto);
  }

  @Post('fx/convert')
  @HttpCode(200)
  @ApiOperation({ summary: 'Ejecutar una cotización' })
  convert(@CurrentUser() u: JwtPayload, @Body() dto: FxConvertDto) {
    return this.wallet.convert(u.sub, dto.quoteId);
  }
}

/** API interna: la usan card-service y payments-service. No pasa por el gateway. */
@UseGuards(InternalKeyGuard)
@Controller('internal/wallet')
export class InternalWalletController {
  constructor(
    private readonly wallet: WalletService,
    private readonly ledger: LedgerService,
  ) {}

  @Post('charges')
  @ApiExcludeEndpoint()
  charge(@Body() req: ChargeRequest) {
    return this.wallet.charge(req);
  }

  /** Saldos de un usuario (payments-service los muestra antes de pagar un QR). */
  @Get('accounts/:userId')
  @ApiExcludeEndpoint()
  accounts(@Param('userId', ParseUUIDPipe) userId: string) {
    return this.wallet.internalAccounts(userId);
  }

  /** Cuánto se debitaría (para validar límites antes de cobrar). No mueve dinero. */
  @Post('charges/preview')
  @HttpCode(200)
  @ApiExcludeEndpoint()
  preview(@Body() req: Pick<ChargeRequest, 'amountMinor' | 'currency' | 'fundingCurrency'>) {
    return this.wallet.previewCharge(req);
  }

  @Get('audit')
  @ApiExcludeEndpoint()
  audit() {
    return this.ledger.audit();
  }
}

@Controller('health')
export class HealthController {
  constructor(private readonly db: DataSource) {}

  @Get()
  @ApiExcludeEndpoint()
  async check() {
    await this.db.query('SELECT 1');
    return { service: 'wallet-service', status: 'ok' };
  }
}
