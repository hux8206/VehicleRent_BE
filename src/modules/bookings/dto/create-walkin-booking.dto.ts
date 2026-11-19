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
  Min,
} from 'class-validator';

export class CreateWalkInBookingDto {
  @ApiProperty({ example: 1, description: 'ID chi nhánh' })
  @IsInt()
  @Type(() => Number)
  storeId: number;

  @ApiProperty({ example: 1, description: 'ID dòng xe' })
  @IsInt()
  @Type(() => Number)
  modelId: number;

  @ApiPropertyOptional({ example: 5, description: 'ID biển số xe vật lý được chọn (cho đơn 1 xe)' })
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  vehicleItemId?: number;

  @ApiPropertyOptional({ example: [5, 6], description: 'Danh sách ID biển số xe vật lý được chọn (khi thuê nhiều xe)' })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Type(() => Number)
  vehicleItemIds?: number[];

  @ApiPropertyOptional({ example: 1, description: 'Số lượng xe thuê' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  quantity?: number;

  @ApiProperty({ example: 'Nguyễn Văn A', description: 'Họ tên khách hàng thuê trực tiếp' })
  @IsString()
  @IsNotEmpty()
  customerName: string;

  @ApiProperty({ example: '0912345678', description: 'Số điện thoại khách hàng' })
  @IsString()
  @IsNotEmpty()
  customerPhone: string;

  @ApiPropertyOptional({ example: 'khach@gmail.com' })
  @IsOptional()
  @IsString()
  customerEmail?: string;

  @ApiPropertyOptional({ example: '012345678901', description: 'Số CCCD hoặc GPLX khách cung cấp' })
  @IsOptional()
  @IsString()
  driverLicense?: string;

  @ApiProperty({ example: '2026-11-17T09:00:00.000Z', description: 'Thời gian bắt đầu thuê' })
  @IsDateString()
  startTime: string;

  @ApiProperty({ example: '2026-11-18T09:00:00.000Z', description: 'Thời gian trả xe dự kiến' })
  @IsDateString()
  endTime: string;

  @ApiPropertyOptional({ example: 250000, description: 'Giá thuê mỗi ngày' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  rentPrice?: number;

  @ApiPropertyOptional({ example: 50000, description: 'Tiền cọc nhận tại quầy' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  depositAmount?: number;

  @ApiPropertyOptional({ example: 250000, description: 'Tổng tiền thuê xe' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  totalAmount?: number;

  @ApiPropertyOptional({ example: 'Khách thuê trực tiếp tại quầy' })
  @IsOptional()
  @IsString()
  note?: string;

  @ApiPropertyOptional({ example: true, description: 'true: Giao xe ngay (status 3), false: Đặt trước lấy sau (status 1)' })
  @IsOptional()
  @IsBoolean()
  handoverNow?: boolean;
}
