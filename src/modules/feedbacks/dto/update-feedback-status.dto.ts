import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString } from 'class-validator';

export class UpdateFeedbackStatusDto {
  @ApiProperty({
    description: 'Trạng thái xử lý (0: Chờ duyệt, 1: Đã tiếp nhận, 2: Đã giải quyết / phản hồi)',
    example: 1,
  })
  @IsInt()
  @IsIn([0, 1, 2])
  status: number;

  @ApiPropertyOptional({ description: 'Ghi chú / phản hồi nội bộ của Admin' })
  @IsOptional()
  @IsString()
  adminNote?: string;
}

