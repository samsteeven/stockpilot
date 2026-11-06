import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsEmail,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class OrderLineDto {
  @IsUUID()
  variantId!: string;

  @IsInt()
  @Min(1)
  @Max(100_000)
  quantity!: number;
}

/** Pas de prix ici : il vient du catalogue, côté serveur. */
export class PlaceOrderDto {
  @IsUUID()
  warehouseId!: string;

  @ValidateNested({ each: true })
  @Type(() => OrderLineDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  items!: OrderLineDto[];

  @IsOptional()
  @IsEmail()
  customerEmail?: string;
}

export class OrderQueryDto {
  @IsOptional()
  @IsIn(['PENDING_PAYMENT', 'CONFIRMED', 'CANCELLED'])
  status?: 'PENDING_PAYMENT' | 'CONFIRMED' | 'CANCELLED';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @IsISO8601()
  before?: string;
}

export class AuditQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @IsISO8601()
  before?: string;

  @IsOptional()
  @Matches(/^[a-z_]+\.[a-z_]+$/)
  action?: string;
}

/** Clé fournie par le client : 8 à 200 caractères sûrs (un UUID convient). */
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{8,200}$/;
