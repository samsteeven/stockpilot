import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

const SKU = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class VariantDto {
  @Matches(SKU)
  @Length(1, 64)
  sku!: string;

  @IsString()
  @Length(1, 200)
  name!: string;
}

export class CreateProductDto {
  @Matches(SKU)
  @Length(1, 64)
  sku!: string;

  @IsString()
  @Length(1, 200)
  name!: string;

  @ValidateNested({ each: true })
  @Type(() => VariantDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  variants!: VariantDto[];
}

export class ProductQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @IsUUID()
  cursor?: string;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  search?: string;
}

export class CreateWarehouseDto {
  @Matches(/^[A-Za-z0-9-]{2,16}$/)
  code!: string;

  @IsString()
  @Length(1, 200)
  name!: string;
}
