import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class CancelBookingDto {
  @ApiPropertyOptional({
    example: 'Thay đổi lịch trình công tác đột xuất',
    description: 'Lý do hủy đơn đặt xe',
  })
  @IsOptional()
  @IsString()
  reason?: string;

  @ApiPropertyOptional({
    example: 'Vietcombank',
    description: 'Tên ngân hàng nhận tiền hoàn cọc (nếu đơn đã cọc)',
  })
  @IsOptional()
  @IsString()
  bankName?: string;

  @ApiPropertyOptional({
    example: '1023456789',
    description: 'Số tài khoản nhận tiền hoàn cọc',
  })
  @IsOptional()
  @IsString()
  bankAccountNumber?: string;

  @ApiPropertyOptional({
    example: 'NGUYEN VAN A',
    description: 'Tên chủ tài khoản ngân hàng nhận hoàn tiền',
  })
  @IsOptional()
  @IsString()
  bankAccountName?: string;
}

