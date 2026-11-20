import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiExcludeEndpoint, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { DataSource } from 'typeorm';
import { CurrentUser, JwtAuthGuard, JwtPayload, Roles, UserRole } from '@app/common';
import { RejectDto, SubmitKycDto } from './dto';
import { FileKind, SubmissionStatus } from './entities';
import { KycService, UploadedFiles as Files } from './kyc.service';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const FILE_KINDS: FileKind[] = ['documentFront', 'documentBack', 'selfie'];

@ApiTags('verificación de identidad')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('kyc')
export class KycController {
  constructor(private readonly kyc: KycService) {}

  @Get('status')
  @ApiOperation({ summary: 'Estado de mi verificación de identidad' })
  status(@CurrentUser() u: JwtPayload) {
    return this.kyc.status(u.sub);
  }

  @Post('submissions')
  @ApiOperation({ summary: 'Enviar datos personales + fotos del documento y selfie' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['firstName', 'lastName', 'birthDate', 'nationality', 'documentType', 'documentNumber',
        'documentExpiresAt', 'addressLine1', 'city', 'state', 'postalCode', 'country', 'phone', 'occupation',
        'documentFront', 'selfie'],
      properties: {
        firstName: { type: 'string', example: 'Ana María' },
        lastName: { type: 'string', example: 'Pérez' },
        birthDate: { type: 'string', example: '1998-04-21' },
        nationality: { type: 'string', example: 'AR' },
        documentType: { type: 'string', enum: ['DNI', 'PASSPORT', 'CEDULA'] },
        documentNumber: { type: 'string', example: '40123456' },
        documentExpiresAt: { type: 'string', example: '2032-04-21' },
        addressLine1: { type: 'string', example: 'Av. Corrientes 1234' },
        city: { type: 'string', example: 'Buenos Aires' },
        state: { type: 'string', example: 'CABA' },
        postalCode: { type: 'string', example: 'C1043' },
        country: { type: 'string', example: 'AR' },
        phone: { type: 'string', example: '+5491155550000' },
        occupation: { type: 'string', example: 'Estudiante' },
        documentFront: { type: 'string', format: 'binary' },
        documentBack: { type: 'string', format: 'binary' },
        selfie: { type: 'string', format: 'binary' },
      },
    },
  })
  @UseInterceptors(
    FileFieldsInterceptor(FILE_KINDS.map((name) => ({ name, maxCount: 1 })), {
      limits: { fileSize: MAX_FILE_BYTES, files: 3, fields: 30 },
    }),
  )
  submit(@CurrentUser() u: JwtPayload, @Body() dto: SubmitKycDto, @UploadedFiles() files: Files = {}) {
    return this.kyc.submit(u.sub, dto, files);
  }
}

@ApiTags('administración KYC')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Roles(UserRole.ADMIN)
@Controller('kyc/admin/submissions')
export class KycAdminController {
  constructor(private readonly kyc: KycService) {}

  @Get()
  @ApiQuery({ name: 'status', required: false, enum: SubmissionStatus })
  @ApiOperation({ summary: 'Cola de verificaciones (solo ADMIN)' })
  list(@Query('status', new ParseEnumPipe(SubmissionStatus, { optional: true })) status?: SubmissionStatus) {
    return this.kyc.list(status);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalle con datos descifrados y verificaciones automáticas' })
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.kyc.detail(id);
  }

  @Get(':id/files/:kind')
  @ApiOperation({ summary: 'Ver foto del documento o selfie' })
  async file(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('kind', new ParseEnumPipe(Object.fromEntries(FILE_KINDS.map((k) => [k, k])))) kind: FileKind,
    @Res({ passthrough: true }) res: Response,
  ) {
    const f = await this.kyc.file(id, kind);
    res.set({ 'Content-Type': f.mime, 'Cache-Control': 'no-store' });
    return new StreamableFile(f.data);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Aprobar la identidad' })
  approve(@CurrentUser() admin: JwtPayload, @Param('id', ParseUUIDPipe) id: string) {
    return this.kyc.approve(id, admin.email);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rechazar con un motivo (el usuario puede reenviar)' })
  reject(@CurrentUser() admin: JwtPayload, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RejectDto) {
    return this.kyc.reject(id, admin.email, dto.reason);
  }
}

@Controller('health')
export class HealthController {
  constructor(private readonly db: DataSource) {}

  @Get()
  @ApiExcludeEndpoint()
  async check() {
    await this.db.query('SELECT 1');
    return { service: 'kyc-service', status: 'ok' };
  }
}
