import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class CreatePromotionDto {
  @ApiProperty({ example: 'CHAOBANMOI', description: 'Mã khuyến mãi (viết hoa)' })
  @IsString()
  @IsNotEmpty()
  code: string;

  @ApiProperty({ example: 'Giảm 10% Chuyến Đầu', description: 'Tiêu đề khuyến mãi' })
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiPropertyOptional({ example: 'Nhập mã ưu đãi khi đặt cọc', description: 'Mô tả chi tiết' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ example: 0, description: '0: Giảm theo %, 1: Giảm số tiền cố định (VNĐ)' })
  @IsInt()
  @Min(0)
  @Max(1)
  @Type(() => Number)
  discountType: number;

  @ApiProperty({ example: 10, description: 'Giá trị giảm (% hoặc VNĐ)' })
  @IsNumber()
  @Type(() => Number)
  discountValue: number;

  @ApiPropertyOptional({ example: 1, description: 'Số ngày thuê tối thiểu' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  minRentDays?: number;

  @ApiPropertyOptional({ example: 100000, description: 'Mức giảm tối đa (VNĐ) khi dùng %' })
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  maxDiscount?: number;

  @ApiPropertyOptional({ example: 'TÂN THỦ', description: 'Huy hiệu hiển thị' })
  @IsOptional()
  @IsString()
  tag?: string;

  @ApiPropertyOptional({ example: ['Áp dụng từ đơn đầu tiên'], description: 'Các quyền lợi' })
  @IsOptional()
  @IsArray()
  bullets?: string[];

  @ApiPropertyOptional({ example: 1000, description: 'Tổng số lượt dùng tối đa' })
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  usageLimit?: number;

  @ApiPropertyOptional({ example: true, description: 'Trạng thái kích hoạt' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

