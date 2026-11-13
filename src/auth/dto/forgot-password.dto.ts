import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty } from 'class-validator';

export class ForgotPasswordDto {
  @ApiProperty({
    example: 'customer1@gmail.com',
    description: 'Địa chỉ email đã đăng ký tài khoản cần khôi phục mật khẩu',
  })
  @IsEmail({}, { message: 'Địa chỉ email không đúng định dạng' })
  @IsNotEmpty({ message: 'Vui lòng nhập địa chỉ email' })
  email: string;
}
