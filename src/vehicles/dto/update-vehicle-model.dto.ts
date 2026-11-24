import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsInt, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class UpdateVehicleModelDto {
  @ApiPropertyOptional({ example: 'Honda Air Blade 125cc 2025' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ example: 'Honda' })
  @IsOptional()
  @IsString()
  brand?: string;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  type?: number;

  @ApiPropertyOptional({ example: 160000 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  rentPrice?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  specifications?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  images?: string[];

  @ApiPropertyOptional({
    description: 'Bảng giá bậc thang theo số ngày thuê ({ minDays: number, maxDays: number | null, pricePerDay: number })',
    example: [
      { minDays: 1, maxDays: 3, pricePerDay: 150000 },
      { minDays: 4, maxDays: 7, pricePerDay: 130000 },
      { minDays: 8, maxDays: null, pricePerDay: 110000 },
    ],
  })
  @IsOptional()
  @IsArray()
  pricingTiers?: Array<{
    minDays: number;
    maxDays: number | null;
    pricePerDay: number;
  }>;
}
