import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { CurrentUser, JwtAuthGuard, JwtPayload } from '@app/common';
import { AuthService } from './auth.service';
import {
  LoginDto,
  LoginVerifyDto,
  RefreshDto,
  RegisterDto,
  ResendOtpDto,
  SetPinDto,
  VerifyEmailDto,
  VerifyPinDto,
} from './dto';

const clientOf = (req: Request) => ({
  userAgent: req.headers['user-agent'],
  ip: (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ?? req.ip,
});

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  @ApiOperation({ summary: 'Registro: crea la cuenta y envía un código al correo' })
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }

  @Post('verify-email')
  @HttpCode(200)
  @ApiOperation({ summary: 'Verifica el correo con el código y abre sesión' })
  verifyEmail(@Body() dto: VerifyEmailDto, @Req() req: Request) {
    return this.auth.verifyEmail(dto, clientOf(req));
  }

  @Post('resend-verification')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reenvía el código de verificación de correo' })
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  resend(@Body() dto: ResendOtpDto) {
    return this.auth.resendVerification(dto.email);
  }

  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Login paso 1: contraseña -> envía código OTP al correo' })
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  @Post('login/verify')
  @HttpCode(200)
  @ApiOperation({ summary: 'Login paso 2: valida el código OTP y entrega los tokens' })
  verifyLogin(@Body() dto: LoginVerifyDto, @Req() req: Request) {
    return this.auth.verifyLogin(dto.challengeId, dto.code, clientOf(req));
  }

  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Renueva el access token (rota el refresh token)' })
  refresh(@Body() dto: RefreshDto, @Req() req: Request) {
    return this.auth.refresh(dto.refreshToken, clientOf(req));
  }

  @Post('logout')
  @HttpCode(204)
  @ApiOperation({ summary: 'Cierra la sesión actual' })
  async logout(@Body() dto: RefreshDto) {
    await this.auth.logout(dto.refreshToken);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Datos del usuario autenticado' })
  me(@CurrentUser() user: JwtPayload) {
    return this.auth.me(user.sub);
  }

  @Post('pin')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Configura o cambia el PIN para confirmar pagos' })
  setPin(@CurrentUser() user: JwtPayload, @Body() dto: SetPinDto) {
    return this.auth.setPin(user.sub, dto);
  }

  @Post('pin/verify')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Verifica el PIN de pagos' })
  verifyPin(@CurrentUser() user: JwtPayload, @Body() dto: VerifyPinDto) {
    return this.auth.verifyPin(user.sub, dto.pin);
  }
}
