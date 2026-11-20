import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { UserRole } from '../constants';
import { JwtPayload } from './jwt-payload';
import { ROLES_KEY } from './roles.decorator';

/**
 * Valida el access token (Bearer) emitido por auth-service.
 * Cada microservicio lo usa con el mismo JWT_ACCESS_SECRET, así no dependen
 * de una llamada de red a auth-service en cada request.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const header: string | undefined = req.headers['authorization'];
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Falta el token de acceso');
    }
    try {
      req.user = await this.jwt.verifyAsync<JwtPayload>(header.slice(7));
    } catch {
      throw new UnauthorizedException('Token inválido o expirado');
    }

    const roles = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (roles?.length && !roles.includes((req.user as JwtPayload).role)) {
      throw new ForbiddenException('No tienes permisos para esta operación');
    }
    return true;
  }
}
