import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  HttpCode,
  Injectable,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { DataSource } from 'typeorm';
import { CurrentUser, JwtAuthGuard, JwtPayload } from '@app/common';
import { CardsService } from './cards.service';
import { AuthorizeDto, LimitDto, PinDto } from './dto';

/**
 * Comercios / terminales que pueden cobrar con tarjeta.
 * Temporal: en la etapa 3 cada comercio tendrá su propia API key en payments-service.
 */
@Injectable()
class AcquirerKeyGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const key = ctx.switchToHttp().getRequest().headers['x-api-key'];
    const allowed = (process.env.CARD_ACQUIRER_API_KEYS ?? '').split(',').map((k) => k.trim()).filter(Boolean);
    if (!key || !allowed.includes(key)) throw new UnauthorizedException('API key de comercio inválida');
    return true;
  }
}

@ApiTags('cards')
@Controller('cards')
export class CardsController {
  constructor(private readonly cards: CardsService) {}

  @Get('eligibility')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Requisitos para habilitar la tarjeta virtual' })
  eligibility(@CurrentUser() u: JwtPayload) {
    return this.cards.eligibility(u.sub);
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Mis tarjetas (datos enmascarados)' })
  list(@CurrentUser() u: JwtPayload) {
    return this.cards.list(u.sub);
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Habilitar tarjeta virtual (requiere PIN)' })
  issue(@CurrentUser() u: JwtPayload, @Body() dto: PinDto) {
    return this.cards.issue(u.sub, dto.pin);
  }

  /** Va antes de las rutas con :id para que "authorizations" no se interprete como id. */
  @Post('authorizations')
  @HttpCode(200)
  @UseGuards(AcquirerKeyGuard)
  @ApiSecurity('x-api-key')
  @ApiOperation({ summary: 'Red de tarjetas: el comercio cobra con los datos que rellenó el cliente' })
  authorize(@Body() dto: AuthorizeDto) {
    return this.cards.authorize(dto);
  }

  @Post(':id/details')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Ver datos completos (número, vencimiento, CVV) — requiere PIN' })
  details(@CurrentUser() u: JwtPayload, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PinDto) {
    return this.cards.details(u.sub, id, dto.pin);
  }

  @Post(':id/freeze')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Pausar la tarjeta' })
  freeze(@CurrentUser() u: JwtPayload, @Param('id', ParseUUIDPipe) id: string) {
    return this.cards.freeze(u.sub, id);
  }

  @Post(':id/unfreeze')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Reactivar la tarjeta' })
  unfreeze(@CurrentUser() u: JwtPayload, @Param('id', ParseUUIDPipe) id: string) {
    return this.cards.unfreeze(u.sub, id);
  }

  @Patch(':id/limit')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Cambiar el límite de gasto mensual' })
  limit(@CurrentUser() u: JwtPayload, @Param('id', ParseUUIDPipe) id: string, @Body() dto: LimitDto) {
    return this.cards.setLimit(u.sub, id, dto);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Dar de baja la tarjeta (definitivo, requiere PIN)' })
  cancel(@CurrentUser() u: JwtPayload, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PinDto) {
    return this.cards.cancel(u.sub, id, dto.pin);
  }

  @Get(':id/transactions')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Compras aprobadas y rechazadas de la tarjeta' })
  transactions(@CurrentUser() u: JwtPayload, @Param('id', ParseUUIDPipe) id: string) {
    return this.cards.transactions(u.sub, id);
  }
}

@Controller('health')
export class HealthController {
  constructor(private readonly db: DataSource) {}

  @Get()
  @ApiExcludeEndpoint()
  async check() {
    await this.db.query('SELECT 1');
    return { service: 'card-service', status: 'ok' };
  }
}
