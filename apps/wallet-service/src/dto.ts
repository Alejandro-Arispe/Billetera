import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { AMOUNT_REGEX, Currency, SUPPORTED_CURRENCIES } from '@app/common';

const amountMsg = { message: 'El monto debe ser un texto como "25.50" (máx. 2 decimales)' };
const upper = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.toUpperCase() : value);

export class TopupDto {
  @ApiProperty({ enum: SUPPORTED_CURRENCIES, example: 'USD' })
  @Transform(upper)
  @IsIn(SUPPORTED_CURRENCIES)
  currency!: Currency;

  @ApiProperty({ example: '100.00' })
  @Matches(AMOUNT_REGEX, amountMsg)
  amount!: string;
}

export class TransferDto {
  @ApiProperty({ example: 'beto@correo.com', description: 'Correo del destinatario' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  toEmail!: string;

  @ApiProperty({ enum: SUPPORTED_CURRENCIES, example: 'USD' })
  @Transform(upper)
  @IsIn(SUPPORTED_CURRENCIES)
  currency!: Currency;

  @ApiProperty({ example: '25.00' })
  @Matches(AMOUNT_REGEX, amountMsg)
  amount!: string;

  @ApiPropertyOptional({ example: 'Pizza del viernes' })
  @IsOptional()
  @IsString()
  @MaxLength(140)
  description?: string;

  @ApiProperty({ example: '4821', description: 'PIN de pagos' })
  @Matches(/^\d{4,6}$/)
  pin!: string;
}

export class FxQuoteDto {
  @ApiProperty({ enum: SUPPORTED_CURRENCIES, example: 'USD' })
  @Transform(upper)
  @IsIn(SUPPORTED_CURRENCIES)
  from!: Currency;

  @ApiProperty({ enum: SUPPORTED_CURRENCIES, example: 'ARS' })
  @Transform(upper)
  @IsIn(SUPPORTED_CURRENCIES)
  to!: Currency;

  @ApiProperty({ example: '10.00', description: 'Monto a vender en la moneda "from"' })
  @Matches(AMOUNT_REGEX, amountMsg)
  amount!: string;
}

export class FxConvertDto {
  @ApiProperty({ description: 'id devuelto por POST /wallet/fx/quotes' })
  @IsUUID()
  quoteId!: string;
}

export class HistoryQueryDto {
  @ApiPropertyOptional({ enum: SUPPORTED_CURRENCIES })
  @IsOptional()
  @Transform(upper)
  @IsIn(SUPPORTED_CURRENCIES)
  currency?: Currency;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;
}
