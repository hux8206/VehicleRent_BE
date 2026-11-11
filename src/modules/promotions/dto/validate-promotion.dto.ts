import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsNumber, IsString, Min } from 'class-validator';

export class ValidatePromotionDto {
  @ApiProperty({ example: 'CHAOBANMOI' })
  @IsString()
  @IsNotEmpty()
  code: string;

  @ApiProperty({ example: 3, description: 'Số ngày thuê' })
  @IsNumber()
  @Min(0.1)
  @Type(() => Number)
  dayRent: number;

  @ApiProperty({ example: 450000, description: 'Tổng tiền thuê ban đầu (VNĐ)' })
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  rentAmount: number;
}

