import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, IsUUID, Length, Matches, MaxLength, MinLength } from 'class-validator';

const normalizeEmail = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class RegisterDto {
  @ApiProperty({ example: 'ana@correo.com' })
  @Transform(normalizeEmail)
  @IsEmail({}, { message: 'Correo inválido' })
  email!: string;

  @ApiProperty({ example: 'Clave$egura123', description: 'Mín. 8 caracteres, con mayúscula, minúscula y número' })
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  @Matches(/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/, {
    message: 'La contraseña debe tener mayúscula, minúscula y número',
  })
  password!: string;

  @ApiProperty({ example: 'Ana Pérez' })
  @IsString()
  @Length(3, 120)
  fullName!: string;
}

export class VerifyEmailDto {
  @ApiProperty({ example: 'ana@correo.com' })
  @Transform(normalizeEmail)
  @IsEmail()
  email!: string;

  @ApiProperty({ example: '123456' })
  @Matches(/^\d{6}$/, { message: 'El código tiene 6 dígitos' })
  code!: string;
}

export class ResendOtpDto {
  @ApiProperty({ example: 'ana@correo.com' })
  @Transform(normalizeEmail)
  @IsEmail()
  email!: string;
}

export class LoginDto {
  @ApiProperty({ example: 'ana@correo.com' })
  @Transform(normalizeEmail)
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'Clave$egura123' })
  @IsString()
  @MaxLength(72)
  password!: string;
}

export class LoginVerifyDto {
  @ApiProperty({ description: 'challengeId devuelto por /auth/login' })
  @IsUUID()
  challengeId!: string;

  @ApiProperty({ example: '123456' })
  @Matches(/^\d{6}$/, { message: 'El código tiene 6 dígitos' })
  code!: string;
}

export class RefreshDto {
  @ApiProperty()
  @IsString()
  @Length(20, 200)
  refreshToken!: string;
}

export class SetPinDto {
  @ApiProperty({ example: '1234', description: 'PIN de 4 a 6 dígitos para confirmar pagos' })
  @Matches(/^\d{4,6}$/, { message: 'El PIN debe tener entre 4 y 6 dígitos' })
  pin!: string;

  @ApiProperty({ description: 'Contraseña actual, para confirmar el cambio' })
  @IsString()
  @MaxLength(72)
  password!: string;
}

export class VerifyPinDto {
  @ApiProperty({ example: '1234' })
  @Matches(/^\d{4,6}$/)
  pin!: string;
}

