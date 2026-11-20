import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { AMOUNT_REGEX, Currency, SUPPORTED_CURRENCIES } from '@app/common';

const upper = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.toUpperCase() : value);

export class CreateMerchantDto {
  @ApiProperty({ example: 'Cafetería Central' })
  @IsString()
  @Length(2, 80)
  name!: string;

  @ApiPropertyOptional({ example: 'http://localhost:5000/webhooks/billetera' })
  @IsOptional()
  @IsUrl({ require_tld: false, protocols: ['http', 'https'] })
  webhookUrl?: string;
}

export class AdminCreateMerchantDto extends CreateMerchantDto {
  @ApiProperty({
    example: 'caja@miempresa.bo',
    description: 'Cuenta de la billetera que recibe el dinero de los cobros (debe existir y estar activa)',
  })
  @IsEmail()
  ownerEmail!: string;
}

export class UpdateMerchantDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(2, 80)
  name?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsUrl({ require_tld: false, protocols: ['http', 'https'] })
  webhookUrl?: string;
}

export class ItemDto {
  @ApiProperty({ example: 'Café latte' })
  @IsString()
  @Length(1, 80)
  name!: string;

  @ApiProperty({ example: 2 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(999)
  quantity!: number;

  @ApiProperty({ example: '3.50' })
  @Matches(AMOUNT_REGEX)
  unitPrice!: string;
}

export class CreateIntentDto {
  @ApiProperty({ example: '7.00' })
  @Matches(AMOUNT_REGEX, { message: 'El monto debe ser un texto como "25.50"' })
  amount!: string;

  @ApiProperty({ enum: SUPPORTED_CURRENCIES, example: 'USD' })
  @Transform(upper)
  @IsIn(SUPPORTED_CURRENCIES)
  currency!: Currency;

  @ApiProperty({ example: 'ORD-1001', description: 'Id de la orden en tu sistema (único)' })
  @IsString()
  @Length(1, 64)
  reference!: string;

  @ApiPropertyOptional({ example: 'Pedido mesa 4' })
  @IsOptional()
  @IsString()
  @MaxLength(140)
  description?: string;

  @ApiPropertyOptional({ type: [ItemDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ItemDto)
  items?: ItemDto[];

  @ApiPropertyOptional({ example: 300, description: 'Vigencia del QR en segundos (15 a 3600). Por defecto 300' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(15)
  @Max(3600)
  expiresInSeconds?: number;
}

export class ScanDto {
  @ApiProperty({ example: 'http://localhost:4000/pay?i=...&s=...', description: 'Texto leído del QR' })
  @IsString()
  @MaxLength(500)
  qr!: string;
}

export class PayDto {
  @ApiProperty({ example: '4821' })
  @Matches(/^\d{4,6}$/, { message: 'PIN inválido' })
  pin!: string;

  @ApiPropertyOptional({ enum: SUPPORTED_CURRENCIES, description: 'Cuenta con la que pagas. Por defecto la del cobro' })
  @IsOptional()
  @Transform(upper)
  @IsIn(SUPPORTED_CURRENCIES)
  fundingCurrency?: Currency;
}
