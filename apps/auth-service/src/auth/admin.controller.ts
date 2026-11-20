import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { ILike, MoreThan, Repository } from 'typeorm';
import { CurrentUser, JwtAuthGuard, JwtPayload, Roles, UserRole } from '@app/common';
import { User, UserStatus } from '../entities/user.entity';
import { TokensService } from './tokens.service';

/** Administración de usuarios (solo ADMIN). */
@ApiTags('administración')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Roles(UserRole.ADMIN)
@Controller('auth/admin')
export class AdminController {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly tokens: TokensService,
  ) {}

  @Get('stats')
  @ApiOperation({ summary: 'Totales de usuarios por estado, verificación y rol' })
  async stats() {
    const group = async (col: 'status' | 'kyc_status' | 'role') =>
      Object.fromEntries(
        (
          await this.users
            .createQueryBuilder('u')
            .select(`u.${col}`, 'k')
            .addSelect('COUNT(*)::int', 'n')
            .groupBy(`u.${col}`)
            .getRawMany<{ k: string; n: number }>()
        ).map((r) => [r.k, r.n]),
      );
    return {
      total: await this.users.count(),
      last24h: await this.users.count({ where: { createdAt: MoreThan(new Date(Date.now() - 86_400_000)) } }),
      byStatus: await group('status'),
      byKyc: await group('kyc_status'),
      byRole: await group('role'),
    };
  }

  @Get('users')
  @ApiQuery({ name: 'q', required: false, description: 'Busca por correo o nombre' })
  @ApiQuery({ name: 'page', required: false })
  @ApiOperation({ summary: 'Listado de usuarios' })
  async list(@Query('q') q?: string, @Query('page') page = '1') {
    const p = Math.max(1, Number(page) || 1);
    const term = q?.trim();
    const [rows, total] = await this.users.findAndCount({
      where: term ? [{ email: ILike(`%${term}%`) }, { fullName: ILike(`%${term}%`) }] : {},
      order: { createdAt: 'DESC' },
      skip: (p - 1) * 50,
      take: 50,
    });
    return {
      page: p,
      total,
      items: rows.map((u) => ({
        id: u.id,
        email: u.email,
        fullName: u.fullName,
        role: u.role,
        status: u.status,
        kycStatus: u.kycStatus,
        hasPin: !!u.pinHash,
        createdAt: u.createdAt,
      })),
    };
  }

  @Post('users/:id/block')
  @HttpCode(200)
  @ApiOperation({ summary: 'Bloquear usuario: no puede ingresar y se cierran sus sesiones' })
  async block(@CurrentUser() admin: JwtPayload, @Param('id', ParseUUIDPipe) id: string) {
    const user = await this.find(id);
    if (user.id === admin.sub) throw new BadRequestException('No puedes bloquearte a ti mismo');
    if (user.role === UserRole.ADMIN) throw new ForbiddenException('No se puede bloquear a otro administrador');
    if (user.status === UserStatus.PENDING_EMAIL) throw new BadRequestException('El usuario aún no verificó su correo');
    user.status = UserStatus.BLOCKED;
    await this.users.save(user);
    await this.tokens.revokeAll(user.id);
    return { id: user.id, status: user.status };
  }

  @Post('users/:id/unblock')
  @HttpCode(200)
  @ApiOperation({ summary: 'Desbloquear usuario' })
  async unblock(@Param('id', ParseUUIDPipe) id: string) {
    const user = await this.find(id);
    if (user.status !== UserStatus.BLOCKED) throw new BadRequestException('El usuario no está bloqueado');
    user.status = UserStatus.ACTIVE;
    user.failedLoginAttempts = 0;
    user.lockedUntil = null;
    await this.users.save(user);
    return { id: user.id, status: user.status };
  }

  private async find(id: string) {
    const u = await this.users.findOne({ where: { id } });
    if (!u) throw new NotFoundException('Usuario no encontrado');
    return u;
  }
}
