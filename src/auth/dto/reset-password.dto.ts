import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsString, Length, MinLength } from 'class-validator';

export class ResetPasswordDto {
  @ApiProperty({
    example: 'customer1@gmail.com',
    description: 'Địa chỉ email của tài khoản cần đổi mật khẩu',
  })
  @IsEmail({}, { message: 'Địa chỉ email không đúng định dạng' })
  @IsNotEmpty({ message: 'Vui lòng nhập địa chỉ email' })
  email: string;

  @ApiProperty({
    example: '123456',
    description: 'Mã xác nhận OTP gồm 6 chữ số được gửi qua email',
  })
  @IsString({ message: 'Mã OTP phải là chuỗi ký tự' })
  @Length(6, 6, { message: 'Mã xác nhận OTP phải gồm đúng 6 chữ số' })
  otp: string;

  @ApiProperty({
    example: 'MatKhauMoi@123',
    description: 'Mật khẩu mới (tối thiểu 6 ký tự)',
  })
  @IsString({ message: 'Mật khẩu phải là chuỗi ký tự' })
  @MinLength(6, { message: 'Mật khẩu mới phải có độ dài tối thiểu từ 6 ký tự trở lên' })
  newPassword: string;
}

