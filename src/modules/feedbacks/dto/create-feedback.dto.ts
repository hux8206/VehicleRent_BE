import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class CreateFeedbackDto {
  @ApiProperty({ description: 'Họ và tên người góp ý', example: 'Nguyễn Văn A' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  fullName: string;

  @ApiProperty({ description: 'Email liên hệ', example: 'customer@gmail.com' })
  @IsEmail()
  @IsNotEmpty()
  @MaxLength(255)
  email: string;

  @ApiPropertyOptional({ description: 'Số điện thoại liên hệ', example: '0912345678' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @ApiPropertyOptional({
    description: 'Chủ đề góp ý',
    example: 'SERVICE',
    enum: ['SERVICE', 'APP_UI', 'POLICY', 'VEHICLE', 'BUG', 'OTHER'],
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  category?: string;

  @ApiPropertyOptional({ description: 'Đánh giá mức độ hài lòng (1 - 5 sao)', example: 5, default: 5 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  rating?: number;

  @ApiProperty({ description: 'Tiêu đề góp ý', example: 'Góp ý thêm phương thức thanh toán ví điện tử' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  subject: string;

  @ApiProperty({ description: 'Nội dung chi tiết đóng góp ý kiến', example: 'Tôi mong muốn nền tảng bổ sung thêm...' })
  @IsString()
  @IsNotEmpty()
  content: string;

  @ApiPropertyOptional({ description: 'ID người dùng nếu đã đăng nhập' })
  @IsOptional()
  @IsInt()
  userId?: number;
}

