import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiQuery, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { DataSource } from 'typeorm';
import { CurrentUser, JwtAuthGuard, JwtPayload, Roles, UserRole } from '@app/common';
import { CreateIntentDto, CreateMerchantDto, PayDto, ScanDto, UpdateMerchantDto } from './dto';
import { IntentStatus, Merchant } from './entities';
import { IntentsService } from './intents.service';
import { CurrentMerchant, MerchantKeyGuard } from './merchant-key.guard';
import { MerchantsService } from './merchants.service';

/** Alta del comercio, hecha por un usuario de la billetera desde su sesión. */
@ApiTags('comercios')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('payments/merchants')
export class MerchantsController {
  constructor(private readonly merchants: MerchantsService) {}

  @Post()
  @ApiOperation({ summary: 'Registrar mi comercio (devuelve la API key una sola vez)' })
  create(@CurrentUser() u: JwtPayload, @Body() dto: CreateMerchantDto) {
    return this.merchants.create(u.sub, dto);
  }

  @Get('me')
  @ApiOperation({ summary: 'Datos de mi comercio y secreto de webhooks' })
  mine(@CurrentUser() u: JwtPayload) {
    return this.merchants.mine(u.sub);
  }

  @Patch('me')
  @ApiOperation({ summary: 'Cambiar nombre o URL de webhook' })
  update(@CurrentUser() u: JwtPayload, @Body() dto: UpdateMerchantDto) {
    return this.merchants.update(u.sub, dto);
  }

  @Post('me/rotate-key')
  @HttpCode(200)
  @ApiOperation({ summary: 'Generar una API key nueva (invalida la anterior)' })
  rotate(@CurrentUser() u: JwtPayload) {
    return this.merchants.rotateKey(u.sub);
  }
}

/** API para el POS / otros proyectos. Se autentica con la API key del comercio. */
@ApiTags('cobros (POS)')
@ApiSecurity('x-api-key')
@UseGuards(MerchantKeyGuard)
@Controller('payments/intents')
export class IntentsController {
  constructor(private readonly intents: IntentsService) {}

  @Post()
  @ApiOperation({ summary: 'Crear un cobro: devuelve el QR (texto e imagen) para mostrar en pantalla' })
  create(@CurrentMerchant() m: Merchant, @Body() dto: CreateIntentDto) {
    return this.intents.create(m, dto);
  }

  @Get()
  @ApiQuery({ name: 'status', required: false, enum: IntentStatus })
  @ApiOperation({ summary: 'Últimos cobros del comercio' })
  list(
    @CurrentMerchant() m: Merchant,
    @Query('status', new ParseEnumPipe(IntentStatus, { optional: true })) status?: IntentStatus,
  ) {
    return this.intents.list(m, status);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Consultar el estado de un cobro (alternativa a los webhooks)' })
  get(@CurrentMerchant() m: Merchant, @Param('id', ParseUUIDPipe) id: string) {
    return this.intents.getForMerchant(m, id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancelar un cobro pendiente' })
  cancel(@CurrentMerchant() m: Merchant, @Param('id', ParseUUIDPipe) id: string) {
    return this.intents.cancel(m, id);
  }

  @Get(':id/webhooks')
  @ApiOperation({ summary: 'Historial de webhooks enviados para este cobro' })
  webhooks(@CurrentMerchant() m: Merchant, @Param('id', ParseUUIDPipe) id: string) {
    return this.intents.webhookLog(m, id);
  }
}

/** Lo que usa la app de la billetera para pagar un QR. */
@ApiTags('pagar QR (billetera)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('payments/qr')
export class PayController {
  constructor(private readonly intents: IntentsService) {}

  @Post('scan')
  @HttpCode(200)
  @ApiOperation({ summary: 'Leer un QR: valida la firma y muestra comercio, monto y con qué cuenta pagar' })
  scan(@CurrentUser() u: JwtPayload, @Body() dto: ScanDto) {
    return this.intents.scan(u.sub, dto.qr);
  }

  @Post(':intentId/pay')
  @HttpCode(200)
  @ApiOperation({ summary: 'Pagar el cobro con PIN' })
  pay(@CurrentUser() u: JwtPayload, @Param('intentId', ParseUUIDPipe) id: string, @Body() dto: PayDto) {
    return this.intents.pay(u.sub, id, dto);
  }
}

/** Comercios y su actividad (solo ADMIN). */
@ApiTags('administración')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Roles(UserRole.ADMIN)
@Controller('payments/admin')
export class PaymentsAdminController {
  constructor(private readonly db: DataSource) {}

  @Get('merchants')
  @ApiOperation({ summary: 'Comercios con cantidad de cobros, pagados y volumen' })
  async merchants() {
    const rows: {
      id: string;
      name: string;
      owner_user_id: string;
      webhook_url: string | null;
      created_at: Date;
      intents: number;
      paid: number;
      last_activity: Date | null;
    }[] = await this.db.query(
      `SELECT m.id, m.name, m.owner_user_id, m.webhook_url, m.created_at,
              COUNT(i.id)::int AS intents,
              COUNT(i.id) FILTER (WHERE i.status = 'PAID')::int AS paid,
              MAX(i.created_at) AS last_activity
         FROM merchants m LEFT JOIN payment_intents i ON i.merchant_id = m.id
        GROUP BY m.id ORDER BY last_activity DESC NULLS LAST`,
    );
    const volume: { merchant_id: string; currency: string; total: string }[] = await this.db.query(
      `SELECT merchant_id, currency, SUM(amount_minor)::text AS total
         FROM payment_intents WHERE status = 'PAID' GROUP BY merchant_id, currency`,
    );
    const failed: { n: number }[] = await this.db.query(
      `SELECT COUNT(*)::int AS n FROM webhook_deliveries WHERE status = 'FAILED'`,
    );
    return {
      failedWebhooks: failed[0]?.n ?? 0,
      items: rows.map((r) => ({
        id: r.id,
        name: r.name,
        ownerUserId: r.owner_user_id,
        webhookUrl: r.webhook_url,
        createdAt: r.created_at,
        intents: r.intents,
        paid: r.paid,
        lastActivity: r.last_activity,
        volume: volume
          .filter((v) => v.merchant_id === r.id)
          .map((v) => ({ currency: v.currency, total: (Number(v.total) / 100).toFixed(2) })),
      })),
    };
  }
}

@Controller('health')
export class HealthController {
  constructor(private readonly db: DataSource) {}

  @Get()
  @ApiExcludeEndpoint()
  async check() {
    await this.db.query('SELECT 1');
    return { service: 'payments-service', status: 'ok' };
  }
}
