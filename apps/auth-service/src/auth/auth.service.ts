import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { Repository } from 'typeorm';
import { EVENTS, InternalUser, NOTIFICATION_CLIENT, SendWelcomeEmailEvent, UserRole } from '@app/common';
import { KycStatus, User, UserStatus } from '../entities/user.entity';
import { LoginDto, RegisterDto, SetPinDto, VerifyEmailDto } from './dto';
import { OtpService } from './otp.service';
import { ClientInfo, TokenPair, TokensService } from './tokens.service';

const BCRYPT_ROUNDS = 12;
const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @Inject(NOTIFICATION_CLIENT) private readonly notifications: ClientProxy,
    private readonly otp: OtpService,
    private readonly tokens: TokensService,
    private readonly config: ConfigService,
  ) {}

  /** Crea el administrador inicial (ADMIN_EMAIL / ADMIN_PASSWORD) si todavía no existe. */
  async onModuleInit() {
    const email = this.config.get<string>('ADMIN_EMAIL')?.trim().toLowerCase();
    const password = this.config.get<string>('ADMIN_PASSWORD');
    if (!email || !password) return;
    const existing = await this.users.findOne({ where: { email } });
    if (existing) {
      if (existing.role !== UserRole.ADMIN) {
        existing.role = UserRole.ADMIN;
        await this.users.save(existing);
        this.logger.log(`Usuario ${email} promovido a ADMIN`);
      }
      return;
    }
    await this.users.save(
      this.users.create({
        email,
        fullName: 'Administrador',
        passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
        role: UserRole.ADMIN,
        status: UserStatus.ACTIVE,
        emailVerifiedAt: new Date(),
      }),
    );
    this.logger.log(`Administrador inicial creado: ${email}`);
  }

  /** kyc-service informa el resultado de la verificación de identidad. */
  async setKycStatus(id: string, status: KycStatus, legalName?: string) {
    const user = await this.users.findOne({ where: { id } });
    if (!user) throw new NotFoundException('Usuario no encontrado');
    user.kycStatus = status;
    // Al aprobarse, el nombre de la cuenta pasa a ser el nombre legal del documento (va impreso en la tarjeta).
    if (status === KycStatus.APPROVED && legalName) user.fullName = legalName;
    await this.users.save(user);
    return toInternal(user);
  }

  /** Paso 1 del registro: crea el usuario pendiente y envía el código al correo. */
  async register(dto: RegisterDto) {
    const existing = await this.users.findOne({ where: { email: dto.email } });
    if (existing && existing.status !== UserStatus.PENDING_EMAIL) {
      throw new ConflictException('Ya existe una cuenta con ese correo');
    }

    const user = existing ?? this.users.create({ email: dto.email });
    user.fullName = dto.fullName.trim();
    user.passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    await this.users.save(user);
    await this.otp.issue(user, 'EMAIL_VERIFICATION');

    return {
      userId: user.id,
      message: `Te enviamos un código de verificación a ${user.email}`,
    };
  }

  /** Paso 2 del registro: valida el código, activa la cuenta y abre sesión. */
  async verifyEmail(dto: VerifyEmailDto, client: ClientInfo): Promise<TokenPair> {
    const user = await this.users.findOne({ where: { email: dto.email } });
    if (!user) throw new BadRequestException('Código inválido o ya utilizado');
    if (user.status !== UserStatus.PENDING_EMAIL) {
      throw new BadRequestException('Este correo ya fue verificado. Inicia sesión.');
    }

    await this.otp.verifyLatest(user.id, 'EMAIL_VERIFICATION', dto.code);
    user.status = UserStatus.ACTIVE;
    user.emailVerifiedAt = new Date();
    await this.users.save(user);

    const welcome: SendWelcomeEmailEvent = { to: user.email, fullName: user.fullName };
    this.notifications.emit(EVENTS.SEND_WELCOME_EMAIL, welcome);
    return this.tokens.issue(user, client);
  }

  /** Reenvía el código de verificación. No revela si el correo existe. */
  async resendVerification(email: string) {
    const user = await this.users.findOne({ where: { email } });
    if (user?.status === UserStatus.PENDING_EMAIL) {
      await this.otp.issue(user, 'EMAIL_VERIFICATION');
    }
    return { message: 'Si el correo está pendiente de verificación, te enviamos un código nuevo' };
  }

  /** Paso 1 del login: valida la contraseña y envía un código OTP (2FA por correo). */
  async login(dto: LoginDto) {
    const user = await this.users.findOne({ where: { email: dto.email } });
    const invalid = new UnauthorizedException('Correo o contraseña incorrectos');
    if (!user) {
      await bcrypt.hash(dto.password, BCRYPT_ROUNDS); // tiempo constante: no revelar si existe
      throw invalid;
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new ForbiddenException(
        `Cuenta bloqueada temporalmente por intentos fallidos. Intenta después de las ${user.lockedUntil.toLocaleTimeString()}`,
      );
    }

    if (!(await bcrypt.compare(dto.password, user.passwordHash))) {
      user.failedLoginAttempts += 1;
      if (user.failedLoginAttempts >= MAX_FAILED_LOGINS) {
        user.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60_000);
        user.failedLoginAttempts = 0;
      }
      await this.users.save(user);
      throw invalid;
    }

    if (user.status === UserStatus.PENDING_EMAIL) {
      throw new ForbiddenException('Primero verifica tu correo electrónico');
    }
    if (user.status === UserStatus.BLOCKED) {
      throw new ForbiddenException('Tu cuenta está bloqueada. Contacta a soporte.');
    }

    user.failedLoginAttempts = 0;
    user.lockedUntil = null;
    await this.users.save(user);

    const challenge = await this.otp.issue(user, 'LOGIN');
    return {
      challengeId: challenge.id,
      message: `Te enviamos un código de acceso a ${maskEmail(user.email)}`,
      expiresAt: challenge.expiresAt,
    };
  }

  /** Paso 2 del login: valida el OTP y entrega los tokens. */
  async verifyLogin(challengeId: string, code: string, client: ClientInfo): Promise<TokenPair> {
    const otp = await this.otp.verifyById(challengeId, 'LOGIN', code);
    const user = await this.users.findOneOrFail({ where: { id: otp.userId } });
    if (user.status !== UserStatus.ACTIVE) throw new ForbiddenException('Cuenta no disponible');
    return this.tokens.issue(user, client);
  }

  async refresh(refreshToken: string, client: ClientInfo): Promise<TokenPair> {
    const userId = await this.tokens.consume(refreshToken);
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user || user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException('Sesión inválida');
    }
    return this.tokens.issue(user, client);
  }

  logout(refreshToken: string) {
    return this.tokens.revoke(refreshToken);
  }

  async me(userId: string) {
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('Usuario no encontrado');
    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      phone: user.phone,
      role: user.role,
      status: user.status,
      kycStatus: user.kycStatus,
      hasPin: !!user.pinHash,
      emailVerifiedAt: user.emailVerifiedAt,
      createdAt: user.createdAt,
    };
  }

  async setPin(userId: string, dto: SetPinDto) {
    const user = await this.users.findOneOrFail({ where: { id: userId } });
    if (!(await bcrypt.compare(dto.password, user.passwordHash))) {
      throw new UnauthorizedException('Contraseña incorrecta');
    }
    if (/^(\d)\1+$/.test(dto.pin) || '0123456789'.includes(dto.pin)) {
      throw new BadRequestException('El PIN es demasiado simple (evita 1111 o 1234)');
    }
    user.pinHash = await bcrypt.hash(dto.pin, BCRYPT_ROUNDS);
    await this.users.save(user);
    return { message: 'PIN de pagos configurado' };
  }

  /**
   * Usado por la app y por otros servicios (wallet, card, payments) antes de mover dinero.
   * 5 PIN incorrectos bloquean los pagos durante 15 minutos.
   */
  async verifyPin(userId: string, pin: string) {
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('Usuario no encontrado');
    // Un usuario bloqueado no puede mover dinero aunque su token siga vigente unos minutos.
    if (user.status !== UserStatus.ACTIVE) throw new ForbiddenException('Tu cuenta está bloqueada. Contacta a soporte.');
    if (!user.pinHash) throw new BadRequestException('Aún no configuraste tu PIN de pagos');
    if (user.pinLockedUntil && user.pinLockedUntil > new Date()) {
      throw new ForbiddenException('PIN bloqueado por intentos fallidos. Intenta en unos minutos.');
    }

    const valid = await bcrypt.compare(pin, user.pinHash);
    if (!valid) {
      user.pinFailedAttempts += 1;
      const left = MAX_FAILED_LOGINS - user.pinFailedAttempts;
      if (left <= 0) {
        user.pinFailedAttempts = 0;
        user.pinLockedUntil = new Date(Date.now() + LOCK_MINUTES * 60_000);
      }
      await this.users.save(user);
      throw new UnauthorizedException(
        left > 0 ? `PIN incorrecto. Te quedan ${left} intento(s).` : 'PIN bloqueado por 15 minutos',
      );
    }
    if (user.pinFailedAttempts > 0) {
      user.pinFailedAttempts = 0;
      await this.users.save(user);
    }
    return { valid };
  }

  /** Datos mínimos para otros servicios (API interna). */
  async internalById(id: string): Promise<InternalUser> {
    const user = await this.users.findOne({ where: { id } });
    if (!user) throw new NotFoundException('Usuario no encontrado');
    return toInternal(user);
  }

  async internalByEmail(email: string): Promise<InternalUser> {
    const user = await this.users.findOne({ where: { email: email.trim().toLowerCase() } });
    if (!user || user.status !== UserStatus.ACTIVE) {
      throw new NotFoundException('No existe una cuenta activa con ese correo');
    }
    return toInternal(user);
  }
}

const toInternal = (u: User): InternalUser => ({
  id: u.id,
  email: u.email,
  fullName: u.fullName,
  status: u.status,
  kycStatus: u.kycStatus,
  hasPin: !!u.pinHash,
});

function maskEmail(email: string): string {
  const [name, domain] = email.split('@');
  return `${name.slice(0, 2)}${'*'.repeat(Math.max(name.length - 2, 1))}@${domain}`;
}
