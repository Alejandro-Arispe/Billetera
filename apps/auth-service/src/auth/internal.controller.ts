import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { KycStatus } from '../entities/user.entity';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { InternalKeyGuard } from '@app/common';
import { AuthService } from './auth.service';
import { VerifyPinDto } from './dto';

/** API interna para otros microservicios. No se expone en el gateway. */
@ApiExcludeController()
@SkipThrottle()
@UseGuards(InternalKeyGuard)
@Controller('internal/users')
export class InternalController {
  constructor(private readonly auth: AuthService) {}

  @Get('by-email')
  byEmail(@Query('email') email: string) {
    return this.auth.internalByEmail(email ?? '');
  }

  @Get(':id')
  byId(@Param('id', ParseUUIDPipe) id: string) {
    return this.auth.internalById(id);
  }

  @Patch(':id/kyc')
  setKyc(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { status: KycStatus; legalName?: string },
  ) {
    if (!Object.values(KycStatus).includes(body?.status)) throw new BadRequestException('Estado KYC inválido');
    return this.auth.setKycStatus(id, body.status, body.legalName?.slice(0, 120));
  }

  @Post(':id/verify-pin')
  @HttpCode(200)
  verifyPin(@Param('id', ParseUUIDPipe) id: string, @Body() dto: VerifyPinDto) {
    return this.auth.verifyPin(id, dto.pin);
  }
}
