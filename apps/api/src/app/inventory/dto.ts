import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsInt,
  IsOptional,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class ReserveLineDto {
  @IsUUID()
  variantId!: string;

  @IsInt()
  @Min(1)
  @Max(100_000)
  quantity!: number;
}

export class ReserveDto {
  /** Référence de la commande : la même référence ne réserve qu'une fois (rejouer la requête est sans risque). */
  @Length(1, 100)
  reference!: string;

  @IsUUID()
  warehouseId!: string;

  @ValidateNested({ each: true })
  @Type(() => ReserveLineDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  items!: ReserveLineDto[];
}

export class ReceiveDto {
  @IsUUID()
  warehouseId!: string;

  @IsUUID()
  variantId!: string;

  @IsInt()
  @Min(1)
  @Max(1_000_000)
  quantity!: number;

  @IsOptional()
  @IsUUID()
  referenceId?: string;
}

export class StockQueryDto {
  @IsOptional()
  @IsUUID()
  warehouseId?: string;
}
