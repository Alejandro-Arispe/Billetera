import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsDateString, IsEnum, IsString, Length, Matches } from 'class-validator';
import { DocumentType } from './entities';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const upper = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value);

/**
 * Datos personales del formulario de verificación (multipart/form-data, junto con las fotos
 * documentFront, documentBack y selfie).
 */
export class SubmitKycDto {
  @ApiProperty({ example: 'Ana María' })
  @Transform(trim)
  @IsString()
  @Length(2, 60)
  @Matches(/^[\p{L}][\p{L} '.-]*$/u, { message: 'Nombre inválido' })
  firstName!: string;

  @ApiProperty({ example: 'Pérez Gómez' })
  @Transform(trim)
  @IsString()
  @Length(2, 60)
  @Matches(/^[\p{L}][\p{L} '.-]*$/u, { message: 'Apellido inválido' })
  lastName!: string;

  @ApiProperty({ example: '1998-04-21' })
  @IsDateString({ strict: true }, { message: 'Fecha de nacimiento inválida (AAAA-MM-DD)' })
  birthDate!: string;

  @ApiProperty({ example: 'AR', description: 'País de nacionalidad (ISO 3166, 2 letras)' })
  @Transform(upper)
  @Matches(/^[A-Z]{2}$/, { message: 'Nacionalidad: código de 2 letras (AR, MX, PE…)' })
  nationality!: string;

  @ApiProperty({ enum: DocumentType, example: 'DNI' })
  @Transform(upper)
  @IsEnum(DocumentType, { message: 'Tipo de documento: DNI, PASSPORT o CEDULA' })
  documentType!: DocumentType;

  @ApiProperty({ example: '40123456' })
  @Transform(({ value }) => (typeof value === 'string' ? value.replace(/[\s.-]/g, '').toUpperCase() : value))
  @Matches(/^[A-Z0-9]{5,15}$/, { message: 'Número de documento inválido' })
  documentNumber!: string;

  @ApiProperty({ example: '2032-04-21', description: 'Vencimiento del documento' })
  @IsDateString({ strict: true }, { message: 'Vencimiento del documento inválido (AAAA-MM-DD)' })
  documentExpiresAt!: string;

  @ApiProperty({ example: 'Av. Corrientes 1234, 5B' })
  @Transform(trim)
  @IsString()
  @Length(4, 120)
  addressLine1!: string;

  @ApiProperty({ example: 'Buenos Aires' })
  @Transform(trim)
  @IsString()
  @Length(2, 60)
  city!: string;

  @ApiProperty({ example: 'CABA' })
  @Transform(trim)
  @IsString()
  @Length(2, 60)
  state!: string;

  @ApiProperty({ example: 'C1043' })
  @Transform(trim)
  @Matches(/^[A-Za-z0-9 -]{3,10}$/, { message: 'Código postal inválido' })
  postalCode!: string;

  @ApiProperty({ example: 'AR', description: 'País de residencia (ISO 3166, 2 letras)' })
  @Transform(upper)
  @Matches(/^[A-Z]{2}$/, { message: 'País: código de 2 letras' })
  country!: string;

  @ApiProperty({ example: '+5491155550000' })
  @Transform(({ value }) => (typeof value === 'string' ? value.replace(/[\s()-]/g, '') : value))
  @Matches(/^\+\d{8,15}$/, { message: 'Teléfono en formato internacional: +5491155550000' })
  phone!: string;

  @ApiProperty({ example: 'Estudiante' })
  @Transform(trim)
  @IsString()
  @Length(2, 60)
  occupation!: string;
}

export class RejectDto {
  @ApiProperty({ example: 'La foto del documento está borrosa' })
  @Transform(trim)
  @IsString()
  @Length(5, 300)
  reason!: string;
}

