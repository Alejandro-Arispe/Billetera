import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'crypto';
import { IsNull, Repository } from 'typeorm';
import { JwtPayload } from '@app/common';
import { RefreshToken } from '../entities/refresh-token.entity';
import { User } from '../entities/user.entity';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number; // segundos
}

export interface ClientInfo {
  userAgent?: string;
  ip?: string;
}

/** Emite access tokens (JWT corto) y refresh tokens opacos con rotación. */
@Injectable()
export class TokensService {
  private readonly accessTtl: number;
  private readonly refreshTtlDays: number;

  constructor(
    private readonly jwt: JwtService,
    @InjectRepository(RefreshToken) private readonly refreshTokens: Repository<RefreshToken>,
    config: ConfigService,
  ) {
    this.accessTtl = Number(config.get('JWT_ACCESS_TTL_SECONDS', 900));
    this.refreshTtlDays = Number(config.get('JWT_REFRESH_TTL_DAYS', 7));
  }

  async issue(user: User, client: ClientInfo): Promise<TokenPair> {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      kycStatus: user.kycStatus,
    };
    const accessToken = await this.jwt.signAsync(payload, { expiresIn: this.accessTtl });

    const refreshToken = randomBytes(48).toString('base64url');
    await this.refreshTokens.save(
      this.refreshTokens.create({
        userId: user.id,
        tokenHash: this.hash(refreshToken),
        expiresAt: new Date(Date.now() + this.refreshTtlDays * 86_400_000),
        userAgent: client.userAgent?.slice(0, 255) ?? null,
        ip: client.ip ?? null,
      }),
    );

    return { accessToken, refreshToken, tokenType: 'Bearer', expiresIn: this.accessTtl };
  }

  /** Revoca el refresh token usado y devuelve el id de usuario (rotación). */
  async consume(refreshToken: string): Promise<string> {
    const token = await this.refreshTokens.findOne({
      where: { tokenHash: this.hash(refreshToken) },
    });
    if (!token || token.expiresAt < new Date()) {
      throw new UnauthorizedException('Sesión inválida o expirada');
    }
    if (token.revokedAt) {
      // Reutilización de un token ya rotado: posible robo -> cerramos todas las sesiones.
      await this.revokeAll(token.userId);
      throw new UnauthorizedException('Sesión inválida. Vuelve a iniciar sesión.');
    }
    await this.refreshTokens.update({ id: token.id }, { revokedAt: new Date() });
    return token.userId;
  }

  async revoke(refreshToken: string): Promise<void> {
    await this.refreshTokens.update(
      { tokenHash: this.hash(refreshToken), revokedAt: IsNull() },
      { revokedAt: new Date() },
    );
  }

  async revokeAll(userId: string): Promise<void> {
    await this.refreshTokens.update({ userId, revokedAt: IsNull() }, { revokedAt: new Date() });
  }

  private hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
