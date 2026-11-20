import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { UserRole } from '@app/common';

export enum UserStatus {
  PENDING_EMAIL = 'PENDING_EMAIL', // registrado, falta verificar el correo
  ACTIVE = 'ACTIVE',
  BLOCKED = 'BLOCKED',
}

/** Estado de verificación de identidad (lo actualizará kyc-service en la etapa 4). */
export enum KycStatus {
  NOT_STARTED = 'NOT_STARTED',
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ unique: true })
  email!: string;

  @Column({ name: 'password_hash' })
  passwordHash!: string;

  @Column({ name: 'full_name' })
  fullName!: string;

  @Column({ type: 'varchar', nullable: true })
  phone!: string | null;

  @Column({ type: 'enum', enum: UserRole, default: UserRole.USER })
  role!: UserRole;

  @Column({ type: 'enum', enum: UserStatus, default: UserStatus.PENDING_EMAIL })
  status!: UserStatus;

  @Column({ name: 'kyc_status', type: 'enum', enum: KycStatus, default: KycStatus.NOT_STARTED })
  kycStatus!: KycStatus;

  @Column({ name: 'email_verified_at', type: 'timestamptz', nullable: true })
  emailVerifiedAt!: Date | null;

  /** PIN de 4-6 dígitos para confirmar pagos (hasheado). */
  @Column({ name: 'pin_hash', type: 'varchar', nullable: true })
  pinHash!: string | null;

  @Column({ name: 'pin_failed_attempts', default: 0 })
  pinFailedAttempts!: number;

  @Column({ name: 'pin_locked_until', type: 'timestamptz', nullable: true })
  pinLockedUntil!: Date | null;

  @Column({ name: 'failed_login_attempts', default: 0 })
  failedLoginAttempts!: number;

  @Column({ name: 'locked_until', type: 'timestamptz', nullable: true })
  lockedUntil!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
