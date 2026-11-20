import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, MaxLength, Min } from 'class-validator';
import { AMOUNT_REGEX, Currency, SUPPORTED_CURRENCIES } from '@app/common';

export class PinDto {
  @ApiProperty({ example: '4821', description: 'PIN de pagos' })
  @Matches(/^\d{4,6}$/, { message: 'PIN inválido' })
  pin!: string;
}

export class LimitDto {
  @ApiProperty({ example: '500.00', description: 'Límite de gasto mensual en USD' })
  @Matches(AMOUNT_REGEX)
  monthlyLimit!: string;
}

/**
 * Lo que un comercio (checkout web o terminal POS) envía a la "red de tarjetas":
 * exactamente los datos que el usuario rellena en el formulario de pago.
 */
export class AuthorizeDto {
  @ApiProperty({ example: '4000 0012 3456 7890' })
  @Transform(({ value }) => (typeof value === 'string' ? value.replace(/[\s-]/g, '') : value))
  @Matches(/^\d{13,19}$/, { message: 'Número de tarjeta inválido' })
  cardNumber!: string;

  @ApiProperty({ example: 11 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  expMonth!: number;

  @ApiProperty({ example: 2030, description: 'Año con 4 dígitos (o 2: 30 = 2030)' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(2100)
  expYear!: number;

  @ApiProperty({ example: '123' })
  @Matches(/^\d{3,4}$/, { message: 'CVV inválido' })
  cvv!: string;

  @ApiPropertyOptional({ example: 'ANA PEREZ' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  holderName?: string;

  @ApiProperty({ example: '15.90' })
  @Matches(AMOUNT_REGEX, { message: 'Monto inválido' })
  amount!: string;

  @ApiProperty({ enum: SUPPORTED_CURRENCIES, example: 'USD' })
  @Transform(({ value }) => (typeof value === 'string' ? value.toUpperCase() : value))
  @IsIn(SUPPORTED_CURRENCIES)
  currency!: Currency;

  @ApiProperty({ example: 'Cafetería Central' })
  @IsString()
  @Length(2, 80)
  merchantName!: string;

  @ApiProperty({ example: 'ORDEN-1001', description: 'Referencia única del comercio (idempotencia)' })
  @IsString()
  @Length(1, 64)
  reference!: string;
}
