import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { RegisterCustomerDto } from './dto/register-customer.dto';
import { RegisterPartnerDto } from './dto/register-partner.dto';
import { LoginDto } from './dto/login.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import * as bcrypt from 'bcryptjs';
import { Resend } from 'resend';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async registerCustomer(dto: RegisterCustomerDto) {
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) throw new ConflictException('Email đã được đăng ký');

    const passwordHash = await bcrypt.hash(dto.password, 10);
    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        passwordHash,
        fullName: dto.fullName,
        phone: dto.phone,
        role: 2, // Customer
      },
    });

    const { passwordHash: _, ...result } = user;
    return result;
  }

  async registerPartner(dto: RegisterPartnerDto) {
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) throw new ConflictException('Email đã được đăng ký');

    const passwordHash = await bcrypt.hash(dto.password, 10);

    // Tạo User và PartnerWallet trong cùng 1 transaction
    const user = await this.prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          email: dto.email,
          passwordHash,
          fullName: dto.fullName,
          phone: dto.phone,
          role: 1, // Partner
        },
      });

      const sysConfig = await tx.systemConfig.findFirst();
      const defaultCreditLimit = sysConfig ? Number(sysConfig.creditLimit) : 500000;

      await tx.partnerWallet.create({
        data: {
          partnerId: newUser.id,
          balance: 0,
          creditLimit: defaultCreditLimit,
          status: 1,
        },
      });

      return newUser;
    });

    const { passwordHash: _, ...result } = user;
    return result;
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (!user) throw new UnauthorizedException('Email hoặc mật khẩu không đúng');

    const isMatch = await bcrypt.compare(dto.password, user.passwordHash);
    if (!isMatch) throw new UnauthorizedException('Email hoặc mật khẩu không đúng');

    if (!user.status) {
      throw new UnauthorizedException(
        'Tài khoản của bạn đã bị khóa bởi Quản trị viên sàn. Vui lòng liên hệ ban quản trị để được hỗ trợ.',
      );
    }

    const payload = { sub: user.id, email: user.email, role: user.role };
    const accessToken = this.jwt.sign(payload);

    const { passwordHash: _, ...userResult } = user;
    return { accessToken, user: userResult };
  }

  async getProfile(userId: number) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new BadRequestException('Người dùng không tồn tại');
    const { passwordHash: _, ...result } = user;
    return result;
  }

  async updateProfile(
    userId: number,
    dto: {
      fullName?: string;
      phone?: string;
      bankAccountNum?: string;
      bankName?: string;
    },
  ) {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: dto,
    });
    const { passwordHash: _, ...result } = user;
    return result;
  }

  async findAllUsers() {
    return this.prisma.user.findMany({
      where: {
        role: { in: [1, 2] }, // Không hiển thị Admin (0), chỉ quản lý Partner (1) và Customer (2)
      },
      select: {
        id: true,
        email: true,
        fullName: true,
        phone: true,
        role: true,
        status: true,
        bankAccountNum: true,
        bankName: true,
        createdAt: true,
        partnerWallet: {
          select: {
            balance: true,
            creditLimit: true,
          },
        },
        _count: {
          select: {
            stores: true,
            bookings: true,
            reviews: true,
          },
        },
      },
      orderBy: { id: 'desc' },
    });
  }

  async findUserDetailsForAdmin(userId: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        fullName: true,
        phone: true,
        role: true,
        status: true,
        bankAccountNum: true,
        bankName: true,
        ownerPasswordHash: true,
        ownerPasswordEnabled: true,
        createdAt: true,
        partnerWallet: {
          include: {
            histories: {
              take: 20,
              orderBy: { id: 'desc' },
            },
          },
        },
        stores: {
          include: {
            rentalPolicy: true,
            _count: { select: { vehicleModels: true, bookings: true } },
            vehicleModels: {
              include: {
                _count: { select: { vehicleItems: true } },
                vehicleItems: true,
              },
              orderBy: { id: 'desc' },
            },
            bookings: {
              include: {
                customer: { select: { id: true, fullName: true, phone: true, email: true } },
                bookingDetails: {
                  include: {
                    model: true,
                    vehicleItem: true,
                  },
                },
                payments: true,
                review: true,
              },
              orderBy: { id: 'desc' },
            },
          },
          orderBy: { id: 'desc' },
        },
        bookings: {
          include: {
            store: { select: { id: true, storeName: true, address: true, phoneContact: true } },
            bookingDetails: {
              include: {
                model: true,
                vehicleItem: true,
              },
            },
            payments: true,
            review: true,
          },
          orderBy: { id: 'desc' },
        },
        reviews: {
          include: {
            store: { select: { id: true, storeName: true } },
            booking: { select: { id: true, bookingCode: true } },
          },
          orderBy: { id: 'desc' },
        },
        storeUpdateRequests: {
          include: {
            store: { select: { id: true, storeName: true } },
          },
          orderBy: { id: 'desc' },
        },
      },
    });

    if (!user) throw new NotFoundException('Người dùng không tồn tại');

    const { ownerPasswordHash, ...rest } = user;
    return {
      ...rest,
      hasOwnerPassword: !!ownerPasswordHash,
      isOwnerPasswordEnabled: user.ownerPasswordEnabled !== false,
    };
  }

  async toggleUserStatus(userId: number) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new BadRequestException('Người dùng không tồn tại');
    if (user.role === 0) {
      throw new BadRequestException('Không thể khóa tài khoản Quản trị viên (Admin)!');
    }
    return this.prisma.user.update({
      where: { id: userId },
      data: { status: !user.status },
      select: { id: true, status: true },
    });
  }

  async deleteUserForAdmin(userId: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        stores: {
          select: { id: true },
        },
      },
    });

    if (!user) {
      throw new NotFoundException('Người dùng không tồn tại');
    }

    if (user.role === 0) {
      throw new BadRequestException('Không thể xóa tài khoản Quản trị viên (Admin)!');
    }

    if (user.status) {
      throw new BadRequestException('Chỉ có thể xóa tài khoản đang ở trạng thái bị khóa!');
    }

    // Check if Customer has active bookings
    if (user.role === 2) {
      const activeBooking = await this.prisma.booking.findFirst({
        where: {
          customerId: userId,
          status: { in: [0, 1, 2, 4] }, // Pending, WaitingQueue, Confirmed, InRental
        },
      });
      if (activeBooking) {
        throw new BadRequestException('Không thể xóa tài khoản khách hàng đang có đơn thuê xe hoạt động hoặc chờ nhận xe!');
      }
    }

    // Check if Partner has active bookings in their stores
    if (user.role === 1 && user.stores.length > 0) {
      const storeIds = user.stores.map((s) => s.id);
      const activeStoreBooking = await this.prisma.booking.findFirst({
        where: {
          storeId: { in: storeIds },
          status: { in: [0, 1, 2, 4] },
        },
      });
      if (activeStoreBooking) {
        throw new BadRequestException('Không thể xóa tài khoản đối tác có chi nhánh đang trong đơn thuê xe hoạt động hoặc chờ nhận xe!');
      }
    }

    // Proceed to safely delete user and all related records in transaction
    return this.prisma.$transaction(async (tx) => {
      // 1. If Customer:
      if (user.role === 2) {
        // Delete reviews written by this customer
        await tx.review.deleteMany({ where: { customerId: userId } });

        // Past bookings cleanup
        const pastBookings = await tx.booking.findMany({
          where: { customerId: userId },
          select: { id: true },
        });
        const pastBookingIds = pastBookings.map((b) => b.id);

        if (pastBookingIds.length > 0) {
          await tx.walletHistory.updateMany({
            where: { bookingId: { in: pastBookingIds } },
            data: { bookingId: null },
          });
          await tx.payment.deleteMany({
            where: { bookingId: { in: pastBookingIds } },
          });
          await tx.bookingDetail.deleteMany({
            where: { bookingId: { in: pastBookingIds } },
          });
          await tx.booking.deleteMany({
            where: { customerId: userId },
          });
        }
      }

      // 3. If Partner:
      if (user.role === 1) {
        // Payout requests
        await tx.payoutRequest.deleteMany({ where: { partnerId: userId } });

        // Store update requests
        await tx.storeUpdateRequest.deleteMany({ where: { partnerId: userId } });

        // Partner wallet & histories
        const wallet = await tx.partnerWallet.findUnique({ where: { partnerId: userId } });
        if (wallet) {
          await tx.walletHistory.deleteMany({ where: { walletId: wallet.id } });
          await tx.partnerWallet.delete({ where: { id: wallet.id } });
        }

        // Stores cleanup
        const storeIds = user.stores.map((s) => s.id);
        if (storeIds.length > 0) {
          // Reviews for these stores
          await tx.review.deleteMany({ where: { storeId: { in: storeIds } } });

          // Past bookings for these stores
          const pastStoreBookings = await tx.booking.findMany({
            where: { storeId: { in: storeIds } },
            select: { id: true },
          });
          const pastStoreBookingIds = pastStoreBookings.map((b) => b.id);
          if (pastStoreBookingIds.length > 0) {
            await tx.walletHistory.updateMany({
              where: { bookingId: { in: pastStoreBookingIds } },
              data: { bookingId: null },
            });
            await tx.payment.deleteMany({
              where: { bookingId: { in: pastStoreBookingIds } },
            });
            await tx.bookingDetail.deleteMany({
              where: { bookingId: { in: pastStoreBookingIds } },
            });
            await tx.booking.deleteMany({
              where: { storeId: { in: storeIds } },
            });
          }

          // Vehicle items and models
          const models = await tx.vehicleModel.findMany({
            where: { storeId: { in: storeIds } },
            select: { id: true },
          });
          const modelIds = models.map((m) => m.id);
          if (modelIds.length > 0) {
            await tx.vehicleItem.deleteMany({ where: { modelId: { in: modelIds } } });
            await tx.bookingDetail.deleteMany({ where: { modelId: { in: modelIds } } });
            await tx.vehicleModel.deleteMany({ where: { storeId: { in: storeIds } } });
          }

          // Rental policies
          await tx.rentalPolicy.deleteMany({ where: { storeId: { in: storeIds } } });

          // Delete stores
          await tx.store.deleteMany({ where: { id: { in: storeIds } } });
        }
      }

      // 4. Delete the user
      await tx.user.delete({ where: { id: userId } });

      return { success: true, message: 'Đã xóa vĩnh viễn tài khoản người dùng thành công' };
    });
  }

  /**
   * Flow: Yêu cầu mã OTP khôi phục mật khẩu
   */
  async forgotPassword(dto: ForgotPasswordDto) {
    const email = dto.email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });

    // Để đảm bảo an toàn (chống user enumeration), nếu email không tồn tại vẫn trả về thông báo chung
    if (!user) {
      this.logger.warn(`[ForgotPassword] Yêu cầu reset pass cho email không tồn tại: ${email}`);
      return {
        success: true,
        message: 'Nếu địa chỉ email này tồn tại trong hệ thống, bạn sẽ nhận được mã OTP xác thực trong giây lát.',
      };
    }

    if (!user.status) {
      throw new BadRequestException('Tài khoản này hiện đang bị khóa bởi Quản trị viên sàn.');
    }

    // Sinh mã OTP ngẫu nhiên 6 chữ số (100000 - 999999)
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const hashedOtp = await bcrypt.hash(otp, 10);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 phút

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        resetOtp: hashedOtp,
        resetOtpExpiresAt: expiresAt,
      },
    });

    if (process.env.NODE_ENV !== 'production') {
      this.logger.log(`🔑 [OTP RESET PASSWORD] Mã OTP khôi phục cho ${email} là: >>> ${otp} <<< (Hết hạn: 10 phút)`);
    } else {
      this.logger.log(`🔑 [OTP RESET PASSWORD] Đã tạo mã OTP khôi phục cho tài khoản ${email} (Hết hạn: 10 phút)`);
    }

    // Tích hợp gửi email OTP qua Resend HTTP API
    const resendApiKey = process.env.RESEND_API_KEY || process.env.MAIL_PASS;
    const mailFrom = process.env.MAIL_FROM || 'VehicleRent <noreply@thuexetulai.io.vn>';

    if (!resendApiKey) {
      this.logger.warn(`⚠️ [Resend] Chưa cấu hình RESEND_API_KEY hoặc MAIL_PASS. Bỏ qua bước gửi email thực tế cho ${email}.`);
    } else {
      try {
        const resend = new Resend(resendApiKey);
        const { data, error } = await resend.emails.send({
          from: mailFrom,
          to: [email],
          subject: '[VehicleRent] Mã OTP đặt lại mật khẩu',
          html: `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff;">
  <div style="text-align: center; margin-bottom: 24px;">
    <h2 style="color: #2563eb; margin: 0; font-size: 24px; font-weight: 800; letter-spacing: -0.5px;">VehicleRent</h2>
    <p style="color: #64748b; font-size: 13px; margin: 4px 0 0;">Nền tảng cho thuê xe tự lái uy tín</p>
  </div>
  <div style="border-top: 1px solid #f1f5f9; padding-top: 20px;">
    <p style="color: #1e293b; font-size: 15px; margin: 0 0 12px;">Xin chào <strong>${user.fullName || 'Quý khách'}</strong>,</p>
    <p style="color: #475569; font-size: 14px; line-height: 1.6; margin: 0 0 20px;">
      Hệ thống nhận được yêu cầu khôi phục mật khẩu cho tài khoản <strong>${email}</strong>. Vui lòng sử dụng mã xác thực OTP dưới đây để hoàn tất việc đổi mật khẩu:
    </p>
    <div style="text-align: center; margin: 28px 0; padding: 18px; background-color: #f8fafc; border: 1px dashed #cbd5e1; border-radius: 10px;">
      <span style="font-family: 'Courier New', Courier, monospace; font-size: 32px; font-weight: 800; letter-spacing: 8px; color: #1e40af;">${otp}</span>
    </div>
    <p style="color: #64748b; font-size: 13px; line-height: 1.5; margin: 0 0 12px;">
      ⏱️ Mã OTP này có hiệu lực trong <strong>10 phút</strong>. Vì lý do bảo mật, vui lòng không chia sẻ mã này cho bất kỳ ai.
    </p>
    <p style="color: #94a3b8; font-size: 12px; line-height: 1.5; margin: 20px 0 0; border-top: 1px solid #f1f5f9; padding-top: 16px;">
      Nếu bạn không yêu cầu đổi mật khẩu, vui lòng bỏ qua email này. Tài khoản của bạn vẫn được bảo vệ an toàn.
    </p>
  </div>
</div>
          `,
          text: `Xin chào ${user.fullName || 'Quý khách'},\n\nMã OTP đặt lại mật khẩu của bạn trên VehicleRent là: ${otp}\nMã có hiệu lực trong vòng 10 phút. Tuyệt đối không chia sẻ mã này cho bất kỳ ai.\n\nNếu bạn không yêu cầu thao tác này, vui lòng bỏ qua email.`,
        });

        if (error) {
          this.logger.error(`❌ [Resend] Gửi email OTP tới ${email} thất bại: ${JSON.stringify(error)}`);
        } else {
          this.logger.log(`📧 [Resend] Đã gửi email OTP thành công tới ${email}. Email ID: ${data?.id}`);
        }
      } catch (err: any) {
        this.logger.error(`❌ [Resend] Lỗi ngoại lệ khi gửi email OTP tới ${email}: ${err?.message || err}`);
      }
    }

    return {
      success: true,
      message: 'Mã xác thực OTP (6 chữ số) đã được tạo thành công! Vui lòng nhập mã để tạo mật khẩu mới.',
      devOtp: process.env.NODE_ENV !== 'production' ? otp : undefined,
    };
  }

  /**
   * Flow: Đặt lại mật khẩu mới với mã OTP
   */
  async resetPassword(dto: ResetPasswordDto) {
    const email = dto.email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });

    if (!user || !user.resetOtp || !user.resetOtpExpiresAt) {
      throw new BadRequestException('Yêu cầu không hợp lệ hoặc bạn chưa yêu cầu mã OTP. Vui lòng thử lại.');
    }

    // Kiểm tra thời hạn OTP
    if (new Date() > user.resetOtpExpiresAt) {
      throw new BadRequestException('Mã xác thực OTP đã hết hạn (quá 10 phút). Vui lòng gửi lại yêu cầu mới.');
    }

    // So khớp mã OTP
    const isOtpValid = await bcrypt.compare(dto.otp.trim(), user.resetOtp);
    if (!isOtpValid) {
      throw new BadRequestException('Mã OTP không chính xác. Vui lòng kiểm tra lại 6 chữ số.');
    }

    // Hash mật khẩu mới
    const newPasswordHash = await bcrypt.hash(dto.newPassword, 10);

    // Cập nhật mật khẩu mới và xóa mã OTP (chống dùng lại)
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: newPasswordHash,
        resetOtp: null,
        resetOtpExpiresAt: null,
      },
    });

    this.logger.log(`✅ [ResetPassword] Tài khoản ${email} đã đặt lại mật khẩu mới thành công!`);

    return {
      success: true,
      message: 'Đặt lại mật khẩu thành công! Bạn có thể đăng nhập ngay bằng mật khẩu mới.',
    };
  }
}
