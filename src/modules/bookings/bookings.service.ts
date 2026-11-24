import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateBookingDto } from './dto/create-booking.dto';
import { CancelBookingDto } from './dto/cancel-booking.dto';
import { CreateWalkInBookingDto } from './dto/create-walkin-booking.dto';
import { PaymentsService } from '../payments/payments.service';
import * as bcrypt from 'bcryptjs';

const COMMISSION_RATE = 0.1; // 10% hoa hồng sàn

export interface PricingTier {
  minDays: number;
  maxDays: number | null;
  pricePerDay: number;
}

/**
 * Tính đơn giá thuê mỗi ngày dựa theo bảng giá bậc thang (Tiered Pricing)
 * Fallback về baseRentPrice nếu không khớp mốc nào hoặc không có cấu hình.
 */
export function getTieredPricePerDay(
  baseRentPrice: number,
  pricingTiers: any,
  dayRent: number,
): number {
  if (!Array.isArray(pricingTiers) || pricingTiers.length === 0) {
    return baseRentPrice;
  }
  for (const tier of pricingTiers) {
    const minDays = Number(tier.minDays);
    const maxDays =
      tier.maxDays !== null && tier.maxDays !== undefined && tier.maxDays !== ''
        ? Number(tier.maxDays)
        : null;
    const price = Number(tier.pricePerDay);

    if (minDays <= dayRent && (maxDays === null || dayRent <= maxDays)) {
      if (price > 0) {
        return price;
      }
    }
  }
  return baseRentPrice;
}

@Injectable()
export class BookingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly paymentsService: PaymentsService,
  ) {}

  /**
   * Flow 2: Đặt xe & Giữ chỗ 10 phút
   * Kiểm tra availability, tạo Booking + BookingDetail + Payment
   */
  async create(customerId: number, dto: CreateBookingDto) {
    const { modelId, storeId, startTime, endTime, pickupType, deliveryAddress, paymentType } = dto;
    const quantity = dto.quantity && dto.quantity > 0 ? dto.quantity : 1;

    if (pickupType === 1 && !deliveryAddress) {
      throw new BadRequestException('Địa chỉ giao xe (deliveryAddress) là bắt buộc khi chọn Giao tận nơi');
    }

    const requestStart = new Date(startTime);
    const requestEnd = new Date(endTime);

    if (isNaN(requestStart.getTime()) || isNaN(requestEnd.getTime())) {
      throw new BadRequestException('Thời gian nhận hoặc trả xe không hợp lệ');
    }

    if (requestStart >= requestEnd) {
      throw new BadRequestException('Thời gian trả xe phải sau thời gian nhận xe. Vui lòng chọn lại ngày trả xe.');
    }

    return this.prisma.$transaction(
      async (tx) => {
        // Khóa bi quan (Pessimistic Row-level Lock): Chống race-condition khi nhiều khách cùng bấm đặt 1 xe
        await tx.$executeRaw`SELECT id FROM vehicle_models WHERE id = ${modelId} FOR UPDATE`;

        // ── 1. Lấy thông tin dòng xe và cửa hàng ─────────────────────────────
        const model = await tx.vehicleModel.findUnique({
        where: { id: modelId },
        include: {
          store: {
            include: {
              rentalPolicy: true,
              partner: { select: { id: true, status: true } },
            },
          },
        },
      });
      if (!model) throw new NotFoundException('Dòng xe không tồn tại');
      if (model.storeId !== storeId) throw new BadRequestException('Dòng xe không thuộc cửa hàng này');
      if (model.store.status !== 1) {
        if (model.store.status === 3) {
          throw new BadRequestException('Chi nhánh này đang tạm ngưng hoạt động, không thể đặt xe vào lúc này');
        } else if (model.store.status === 4) {
          throw new BadRequestException('Chi nhánh này đang sửa chữa / bảo trì cơ sở vật chất, tạm dừng nhận đơn');
        } else {
          throw new BadRequestException('Cửa hàng hiện chưa được kích hoạt hoặc tạm ngưng hoạt động');
        }
      }

      // ── 2.1 Kiểm tra giờ hoạt động của cửa hàng (Requirement 1) ──────────
      const openTime = model.store.openTime || '07:00';
      const closeTime = model.store.closeTime || '21:00';

      const parseTime = (timeStr: string) => {
        const [h, m] = timeStr.split(':').map(Number);
        return (h || 0) * 60 + (m || 0);
      };

      const extractMinutes = (dateStr: string, dateObj: Date) => {
        if (dateStr.includes('T') && !dateStr.endsWith('Z')) {
          const timePart = dateStr.split('T')[1].substring(0, 5);
          const [h, m] = timePart.split(':').map(Number);
          if (!isNaN(h) && !isNaN(m)) return h * 60 + m;
        }
        const vnDate = new Date(dateObj.getTime() + 7 * 60 * 60 * 1000);
        return vnDate.getUTCHours() * 60 + vnDate.getUTCMinutes();
      };

      const startMinutes = extractMinutes(startTime, requestStart);
      const endMinutes = extractMinutes(endTime, requestEnd);
      const openMinutes = parseTime(openTime);
      const closeMinutes = parseTime(closeTime);

      const formatMinutes = (mins: number) => {
        const h = String(Math.floor(mins / 60)).padStart(2, '0');
        const m = String(mins % 60).padStart(2, '0');
        return `${h}:${m}`;
      };

      if (startMinutes < openMinutes || startMinutes > closeMinutes) {
        throw new BadRequestException(
          `Giờ nhận xe (${formatMinutes(startMinutes)}) ngoài khung giờ hoạt động của cửa hàng (${openTime} - ${closeTime}). Vui lòng chọn trong giờ hoạt động!`,
        );
      }

      if (endMinutes < openMinutes || endMinutes > closeMinutes) {
        throw new BadRequestException(
          `Giờ trả xe (${formatMinutes(endMinutes)}) ngoài khung giờ hoạt động của cửa hàng (${openTime} - ${closeTime}). Vui lòng chọn trong giờ hoạt động!`,
        );
      }
      if (model.store.partner && !model.store.partner.status) {
        throw new BadRequestException('Tài khoản đối tác của chi nhánh này đang bị khóa bởi hệ thống');
      }

      // ── 3. Tính xe khả dụng (Flow 1) — dùng raw query để tránh race-condition ──
      const totalActiveItems = await tx.vehicleItem.count({
        where: { modelId, status: { not: 3 } },
      });

      const busyAgg = await tx.bookingDetail.aggregate({
        where: {
          modelId,
          booking: {
            AND: [
              {
                OR: [
                  { status: { in: [1, 3] } },
                  { status: 0, holdExpiresAt: { gt: new Date() } },
                ],
              },
              { startTime: { lt: requestEnd } },
              { endTime: { gt: requestStart } },
            ],
          },
        },
        _sum: {
          quantity: true,
        },
      });

      const busyCount = busyAgg._sum.quantity || 0;
      const availableCount = totalActiveItems - busyCount;
      if (availableCount < quantity) {
        throw new BadRequestException(
          `XE_KHONG_KHA_DUNG: Chỉ còn ${availableCount} xe trống trong khoảng thời gian này (Yêu cầu: ${quantity} xe)`,
        );
      }

      // ── 4. Tính tiền (Hỗ trợ Định giá bậc thang theo số ngày thuê) ─────────
      const diffHours = (requestEnd.getTime() - requestStart.getTime()) / (1000 * 60 * 60);
      const dayRent = Math.ceil(diffHours / 24);
      const baseRentPrice = Number(model.rentPrice);
      const pricePerUnit = getTieredPricePerDay(baseRentPrice, model.pricingTiers, dayRent);
      const rentAmount = dayRent * pricePerUnit * quantity;

      // Đọc cấu hình sàn: Mức cọc tối thiểu (mặc định 15%) & Tỷ lệ hoa hồng sàn (mặc định 10%)
      const sysConfig = await tx.systemConfig.findFirst();
      const minDepositPercent = sysConfig ? Number(sysConfig.minDepositPercent) : 15;
      const commissionRate = sysConfig ? Number(sysConfig.commissionRate) / 100 : COMMISSION_RATE;

      const storeDepositPercent = model.store.rentalPolicy
        ? Number(model.store.rentalPolicy.depositPercent)
        : minDepositPercent;
      // Đảm bảo mức cọc của đơn luôn >= mức cọc tối thiểu do Admin quy định
      const effectiveDepositPercent = Math.max(minDepositPercent, storeDepositPercent);

      // ── 4.1 Xử lý mã khuyến mãi (Promotion Voucher) ─────────────────────
      let discountAmount = 0;
      let promotionId: number | null = null;
      let appliedPromoCode: string | null = null;

      if (dto.promotionCode && dto.promotionCode.trim()) {
        const pCode = dto.promotionCode.trim().toUpperCase();
        const promo = await tx.promotion.findUnique({
          where: { code: pCode },
        });

        if (!promo || !promo.isActive) {
          throw new BadRequestException('Mã khuyến mãi không tồn tại hoặc đã bị vô hiệu hóa');
        }
        if (promo.endDate && promo.endDate < new Date()) {
          throw new BadRequestException('Mã khuyến mãi đã hết hạn sử dụng');
        }
        if (promo.startDate && promo.startDate > new Date()) {
          throw new BadRequestException('Chương trình khuyến mãi chưa bắt đầu');
        }
        if (promo.usageLimit !== null && promo.usedCount >= promo.usageLimit) {
          throw new BadRequestException('Mã khuyến mãi đã đạt giới hạn lượt sử dụng');
        }
        if (promo.minRentDays && dayRent < promo.minRentDays) {
          throw new BadRequestException(
            `Mã ${promo.code} yêu cầu thuê xe tối thiểu từ ${promo.minRentDays} ngày trở lên`,
          );
        }

        if (promo.discountType === 0) {
          // Giảm %
          const pct = Number(promo.discountValue);
          let calcDisc = (rentAmount * pct) / 100;
          if (promo.maxDiscount) {
            calcDisc = Math.min(calcDisc, Number(promo.maxDiscount));
          }
          discountAmount = Math.round(calcDisc);
        } else {
          // Giảm số tiền cố định (VNĐ)
          discountAmount = Math.min(rentAmount, Number(promo.discountValue));
        }

        promotionId = promo.id;
        appliedPromoCode = promo.code;

        // Cập nhật số lượt đã dùng
        await tx.promotion.update({
          where: { id: promo.id },
          data: { usedCount: { increment: 1 } },
        });
      }

      const finalRentAmount = Math.max(0, rentAmount - discountAmount);
      const depositAmount =
        paymentType === 1 ? Math.round((finalRentAmount * effectiveDepositPercent) / 100) : finalRentAmount;

      // Ưu đãi đối tác mới: 5 đơn thành công đầu tiên (status in [1, 3, 4]) được miễn 100% hoa hồng sàn (0đ)
      const partnerId = model.store.partnerId;
      const partnerSuccessfulBookingsCount = await tx.booking.count({
        where: {
          store: { partnerId },
          status: { in: [1, 3, 4] },
        },
      });
      const isFreeCommission = partnerSuccessfulBookingsCount < 5;
      const commissionAmount = isFreeCommission ? 0 : Math.round(finalRentAmount * commissionRate);

      // ── 5. Sinh bookingCode ───────────────────────────────────────────────
      const now = new Date();
      const yyymm = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
      const rand = Math.floor(Math.random() * 9000) + 1000;
      const bookingCode = `BK-${yyymm}-${rand}`;

      // ── 6. Tạo Booking với holdExpiresAt = NOW() + 10 phút ───────────────
      const holdExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
      const booking = await tx.booking.create({
        data: {
          bookingCode,
          customerId,
          storeId,
          startTime: requestStart,
          endTime: requestEnd,
          pickupType,
          deliveryAddress,
          dayRent,
          rentAmount: finalRentAmount,
          depositAmount,
          commissionAmount,
          promotionId,
          promotionCode: appliedPromoCode,
          discountAmount,
          holdExpiresAt,
          status: 0, // PendingPayment
        },
      });

      // ── 7. Tìm các xe vật lý khả dụng (status = 0) để tạm giữ chỗ ──────────
      const availableItems = await tx.vehicleItem.findMany({
        where: {
          modelId,
          status: 0, // Sẵn sàng (Available)
        },
        take: quantity,
      });

      // ── Tạo các BookingDetail tương ứng với số lượng xe đặt ───────────────
      const rentPerUnitTotal = pricePerUnit * dayRent;
      for (let i = 0; i < quantity; i++) {
        await tx.bookingDetail.create({
          data: {
            bookingId: booking.id,
            modelId,
            vehicleItemId: availableItems[i] ? availableItems[i].id : null,
            quantity: 1,
            pricePerUnit: pricePerUnit,
            subTotal: rentPerUnitTotal,
          },
        });
      }

      // Cập nhật trạng thái xe vật lý: Sẵn sàng (0) → Đang giữ (1: Reserved)
      if (availableItems.length > 0) {
        const itemIds = availableItems.map((item) => item.id);
        await tx.vehicleItem.updateMany({
          where: { id: { in: itemIds } },
          data: { status: 1 }, // Reserved
        });
      }

      // ── 8. Sinh transactionRef và tạo Payment ────────────────────────────
      const hex = Math.floor(Math.random() * 0xffff)
        .toString(16)
        .toUpperCase()
        .padStart(4, '0');
      const transactionRef = `TX${booking.id}_${hex}`;

      const payment = await tx.payment.create({
        data: {
          bookingId: booking.id,
          transactionRef,
          paymentMethod: 1, // BankTransfer / VietQR
          paymentType,
          amount: depositAmount,
          paymentStatus: 0, // Pending
        },
      });

      return {
        booking,
        payment: {
          transactionRef: payment.transactionRef,
          amount: payment.amount,
          paymentMethod: 'VietQR / Bank Transfer',
        },
        holdExpiresAt,
        message: `Giữ chỗ thành công! Vui lòng thanh toán trong 10 phút. Mã GD: ${transactionRef}`,
      };
    },
    {
      maxWait: 10000,
      timeout: 20000,
    });
  }

  /** Lấy danh sách đơn thuê của Customer */
  async findMyBookings(customerId: number) {
    // Tự động kiểm tra đối soát với PayOS cho các đơn pending gần đây nếu chưa nhận được webhook
    try {
      const recentPending = await this.prisma.booking.findMany({
        where: {
          customerId,
          status: 0,
          createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
        select: { id: true },
      });

      for (const b of recentPending) {
        try {
          await this.paymentsService.checkAndSyncBookingPayment(b.id, customerId);
        } catch {
          // Bỏ qua lỗi đối soát từng đơn riêng lẻ
        }
      }
    } catch {
      // Bỏ qua lỗi chung
    }

    return this.prisma.booking.findMany({
      where: { customerId },
      include: {
        store: { select: { storeName: true, address: true } },
        bookingDetails: { include: { model: { select: { id: true, name: true, brand: true } } } },
        payments: { select: { transactionRef: true, amount: true, paymentStatus: true } },
        review: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Xem chi tiết 1 đơn thuê (Customer chỉ xem đơn của mình) */
  async findOne(customerId: number, bookingId: number) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        store: { include: { rentalPolicy: true } },
        bookingDetails: {
          include: {
            model: true,
            vehicleItem: { select: { licensePlate: true, color: true } },
          },
        },
        payments: true,
        review: true,
      },
    });
    if (!booking) throw new NotFoundException('Đơn thuê không tồn tại');
    if (booking.customerId !== customerId)
      throw new ForbiddenException('Bạn không có quyền xem đơn thuê này');
    return booking;
  }

  /** Customer hủy đơn (Hỗ trợ cả đơn Pending 0 và Confirmed 1 có yêu cầu hoàn cọc) */
  async cancelBooking(customerId: number, bookingId: number, dto?: CancelBookingDto) {
    return this.prisma.$transaction(async (tx) => {
      // 1. Khóa và đọc lại đơn trong transaction (Chống Race Condition & Double Cancellation)
      const booking = await tx.booking.findUnique({
        where: { id: bookingId },
        include: {
          store: true,
          bookingDetails: true,
          payments: true,
        },
      });

      if (!booking) throw new NotFoundException('Đơn thuê không tồn tại');
      if (booking.customerId !== customerId)
        throw new ForbiddenException('Bạn không có quyền hủy đơn thuê này');
      if (booking.status === 5)
        throw new BadRequestException('Đơn thuê này đã được hủy trước đó');
      if (booking.status !== 0 && booking.status !== 1 && booking.status !== 2)
        throw new BadRequestException('Chỉ có thể hủy đơn khi đang chờ thanh toán hoặc đã cọc chờ nhận xe');

      // 2. Hoàn trả tất cả xe vật lý đã giữ về trạng thái Sẵn sàng (status = 0)
      for (const detail of booking.bookingDetails) {
        if (detail.vehicleItemId) {
          await tx.vehicleItem.updateMany({
            where: { id: detail.vehicleItemId, status: 1 },
            data: { status: 0 },
          });
        }
      }

      // 3. Nếu đơn đã thanh toán cọc (status = 1), tính toán tỷ lệ hoàn cọc theo chính sách mới:
      // Quy tắc:
      // 1. Hủy trước >= 24h nhận xe: Hoàn 100% cọc
      // 2. Hủy trước 6h - 24h nhận xe:
      //    - Đặt dưới 30 phút: Hoàn 100% cọc
      //    - Quá 30 phút từ lúc đặt: Hoàn 50% cọc
      // 3. Hủy dưới 6h nhận xe:
      //    - Đặt dưới 30 phút: Hoàn 50% cọc
      //    - Quá 30 phút từ lúc đặt: Mất 100% cọc (0% hoàn lại)
      let refundAmountNum = 0;
      let policyNote = '';
      let initialRefundStatus: number | null = null;

      if (booking.status === 1) {
        if (!dto?.reason?.trim()) {
          throw new BadRequestException('Vui lòng cung cấp lý do hủy đơn');
        }

        const totalDeposit = Number(booking.depositAmount);
        const nowMs = Date.now();
        const startMs = new Date(booking.startTime).getTime();
        const createdMs = new Date(booking.createdAt).getTime();

        const hoursToStart = (startMs - nowMs) / (1000 * 60 * 60);
        const minutesSinceBooking = (nowMs - createdMs) / (1000 * 60);

        if (hoursToStart >= 24) {
          refundAmountNum = totalDeposit;
          policyNote = 'Hủy trước >= 24h nhận xe (Hoàn 100% cọc)';
          initialRefundStatus = 0; // Chờ Admin chuyển khoản
        } else if (hoursToStart >= 6) {
          if (minutesSinceBooking <= 30) {
            refundAmountNum = totalDeposit;
            policyNote = 'Hủy trước 6h - 24h và vừa đặt dưới 30 phút (Hoàn 100% cọc)';
            initialRefundStatus = 0;
          } else {
            refundAmountNum = Math.round(totalDeposit * 0.5);
            policyNote = 'Hủy trước 6h - 24h và quá 30 phút từ lúc đặt (Hoàn 50% cọc, nhà xe giữ 50%)';
            initialRefundStatus = 0;
          }
        } else {
          // hoursToStart < 6
          if (minutesSinceBooking <= 30) {
            refundAmountNum = Math.round(totalDeposit * 0.5);
            policyNote = 'Hủy cận giờ dưới 6h và vừa đặt dưới 30 phút (Hoàn 50% cọc, nhà xe giữ 50%)';
            initialRefundStatus = 0;
          } else {
            refundAmountNum = 0;
            policyNote = 'Hủy cận giờ dưới 6h và quá 30 phút từ lúc đặt (Mất 100% cọc theo quy định)';
            initialRefundStatus = 2; // Không hoàn cọc do vi phạm điều kiện
          }
        }

        // Bắt buộc thông tin tài khoản ngân hàng khi khách đủ điều kiện hoàn cọc (> 0 đ)
        if (refundAmountNum > 0) {
          if (
            !dto?.bankName?.trim() ||
            !dto?.bankAccountNumber?.trim() ||
            !dto?.bankAccountName?.trim()
          ) {
            throw new BadRequestException(
              'Đơn của bạn đủ điều kiện hoàn cọc. Vui lòng nhập đầy đủ thông tin tài khoản ngân hàng để hệ thống hoàn tiền về cho bạn.',
            );
          }
        }

        // Idempotency: Kiểm tra xem đã từng thu hồi tiền hoàn cọc của đơn này trong ví đối tác chưa
        const existingRefundHistory = await tx.walletHistory.findFirst({
          where: {
            bookingId: booking.id,
            type: 2, // Refund
          },
        });

        // Khấu trừ số tiền hoàn trả thực tế từ ví đối tác (đối tác giữ phần còn lại) nếu chưa từng trừ
        if (refundAmountNum > 0 && !existingRefundHistory) {
          const wallet = await tx.partnerWallet.findUnique({
            where: { partnerId: booking.store.partnerId },
          });

          if (wallet) {
            const currentBal = Number(wallet.balance);
            const newBal = currentBal - refundAmountNum;

            await tx.partnerWallet.update({
              where: { id: wallet.id },
              data: { balance: newBal },
            });

            await tx.walletHistory.create({
              data: {
                walletId: wallet.id,
                bookingId: booking.id,
                type: 2, // Refund
                amount: refundAmountNum,
                balanceBefore: currentBal,
                balanceAfter: newBal,
                description: policyNote
                  ? `Hoàn cọc hủy đơn ${booking.bookingCode} [${policyNote.split('(')[0].trim()}]`
                  : `Hoàn cọc hủy đơn ${booking.bookingCode}`,
              },
            });
          }
        }
      }

      // 4. Cập nhật Booking sang trạng thái Đã hủy (status = 5) kèm thông tin hoàn cọc
      const baseReason = dto?.reason?.trim() || 'Khách hàng hủy đơn giữ chỗ';
      const fullReason = policyNote ? `${baseReason} • ${policyNote}` : baseReason;

      return tx.booking.update({
        where: { id: bookingId },
        data: {
          status: 5, // Cancelled
          cancelType: 1, // Khách tự hủy
          cancelReason: fullReason,
          cancelTime: new Date(),
          refundStatus: initialRefundStatus,
          refundBankName: dto?.bankName?.trim() || null,
          refundAccountNumber: dto?.bankAccountNumber?.trim() || null,
          refundAccountName: dto?.bankAccountName?.trim()?.toUpperCase() || null,
          refundAmount: booking.status === 1 ? refundAmountNum : null,
        },
      });
    });
  }

  // ─── PARTNER APIs ─────────────────────────────────────────────────────────

  /** Partner xem tất cả đơn thuê thuộc stores của mình (có thể lọc theo chi nhánh) */
  async findPartnerBookings(partnerId: number, status?: number, storeId?: number) {
    return this.prisma.booking.findMany({
      where: {
        store: { partnerId },
        ...(storeId !== undefined && { storeId }),
        ...(status !== undefined && { status }),
      },
      include: {
        customer: { select: { fullName: true, phone: true } },
        store: { select: { storeName: true } },
        bookingDetails: { include: { model: { select: { name: true } }, vehicleItem: true } },
        payments: { select: { transactionRef: true, paymentStatus: true, amount: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Flow 6a: Partner bàn giao xe — gán biển số + chuyển sang ActiveRental */
  async handoverVehicle(partnerId: number, bookingId: number, vehicleItemIds: number[]) {
    return this.prisma.$transaction(async (tx) => {
      // 1. Khóa và đọc lại đơn trong transaction (Chống Race Condition & Double Handover)
      const booking = await tx.booking.findUnique({
        where: { id: bookingId },
        include: { store: true, bookingDetails: true },
      });
      if (!booking) throw new NotFoundException('Đơn thuê không tồn tại');
      if (booking.store.partnerId !== partnerId)
        throw new ForbiddenException('Đơn thuê không thuộc cửa hàng của bạn');
      if (booking.status !== 1)
        throw new BadRequestException('Đơn phải ở trạng thái Confirmed (1) mới có thể bàn giao xe');

      // Chuẩn hóa nếu đơn cũ chỉ có 1 detail với quantity > 1: tách thành các detail riêng
      if (booking.bookingDetails.length === 1 && booking.bookingDetails[0].quantity > 1) {
        const oldDetail = booking.bookingDetails[0];
        const qty = oldDetail.quantity;
        const unitSubTotal = Number(oldDetail.subTotal) / qty;
        await tx.bookingDetail.update({
          where: { id: oldDetail.id },
          data: { quantity: 1, subTotal: unitSubTotal },
        });
        for (let i = 1; i < qty; i++) {
          await tx.bookingDetail.create({
            data: {
              bookingId: booking.id,
              modelId: oldDetail.modelId,
              vehicleItemId: null,
              quantity: 1,
              pricePerUnit: oldDetail.pricePerUnit,
              subTotal: unitSubTotal,
            },
          });
        }
        booking.bookingDetails = await tx.bookingDetail.findMany({
          where: { bookingId },
        });
      }

      const details = booking.bookingDetails;
      if (!details || details.length === 0) {
        throw new BadRequestException('Đơn thuê không có thông tin chi tiết xe');
      }

      // Lấy danh sách ID các xe đã được giữ trước đó cho đơn này
      const existingHeldItemIds = details
        .map((d) => d.vehicleItemId)
        .filter((id): id is number => typeof id === 'number');

      let finalItemIds = vehicleItemIds;
      if (!finalItemIds || finalItemIds.length === 0) {
        finalItemIds = existingHeldItemIds;
      }

      if (finalItemIds.length !== details.length) {
        throw new BadRequestException(
          `Cần chọn đủ ${details.length} biển số xe để bàn giao (Hiện đã chọn ${finalItemIds.length} xe)`,
        );
      }

      // Kiểm tra trùng lặp biển số trong danh sách chọn bàn giao
      const uniqueIds = new Set(finalItemIds);
      if (uniqueIds.size !== finalItemIds.length) {
        throw new BadRequestException('Không thể chọn cùng 1 biển số xe nhiều lần cho các xe khác nhau');
      }

      // Kiểm tra tính hợp lệ của từng xe bàn giao
      for (const vId of finalItemIds) {
        const vehicleItem = await tx.vehicleItem.findUnique({ where: { id: vId } });
        if (!vehicleItem) throw new NotFoundException(`Xe với ID ${vId} không tồn tại`);
        if (vehicleItem.modelId !== details[0].modelId)
          throw new BadRequestException(`Biển số xe ${vehicleItem.licensePlate} không thuộc dòng xe trong đơn`);

        const isPreAssigned = vehicleItem.status === 1 && existingHeldItemIds.includes(vehicleItem.id);
        if (vehicleItem.status !== 0 && !isPreAssigned) {
          throw new BadRequestException(
            `Xe ${vehicleItem.licensePlate} không ở trạng thái sẵn sàng hoặc đang được đơn này giữ`,
          );
        }
      }

      // Nếu nhân viên chọn bàn giao xe khác xe đã giữ ban đầu, hoàn trả xe cũ về Sẵn sàng (0)
      const unselectedOldItemIds = existingHeldItemIds.filter((id) => !finalItemIds.includes(id));
      if (unselectedOldItemIds.length > 0) {
        await tx.vehicleItem.updateMany({
          where: { id: { in: unselectedOldItemIds } },
          data: { status: 0 },
        });
      }

      // Cập nhật từng bookingDetail và gán status = 2 (Rented) cho xe
      for (let i = 0; i < details.length; i++) {
        await tx.bookingDetail.update({
          where: { id: details[i].id },
          data: { vehicleItemId: finalItemIds[i] },
        });
      }

      await tx.vehicleItem.updateMany({
        where: { id: { in: finalItemIds } },
        data: { status: 2 }, // Rented
      });

      // ── Khấu trừ hoa hồng sàn khi XÁC NHẬN KHÁCH ĐÃ NHẬN XE ───────────────
      // Chỉ khi đối tác bàn giao xe thành công thì sàn mới trừ hoa hồng.
      // Idempotency: Kiểm tra xem đã từng trừ hoa hồng của đơn này chưa (Chống trừ 2 lần)
      const existingCommission = await tx.walletHistory.findFirst({
        where: {
          bookingId: booking.id,
          type: 1, // Commission_Deduction
        },
      });

      // Kiểm tra chính sách ưu đãi đối tác mới: 5 đơn thành công đầu tiên miễn 100% hoa hồng sàn
      const previousSuccessfulCount = await tx.booking.count({
        where: {
          store: { partnerId: booking.store.partnerId },
          status: { in: [3, 4] },
          id: { not: booking.id },
        },
      });
      const isFreeCommission = previousSuccessfulCount < 5 || Number(booking.commissionAmount) === 0;
      const commission = isFreeCommission ? 0 : Number(booking.commissionAmount);

      if (!existingCommission) {
        const wallet = await tx.partnerWallet.findUnique({
          where: { partnerId: booking.store.partnerId },
        });
        if (wallet) {
          if (commission === 0) {
            // Ghi nhận lịch sử miễn phí hoa hồng sàn (0đ) cho đối tác mới
            await tx.walletHistory.create({
              data: {
                walletId: wallet.id,
                bookingId: booking.id,
                type: 1, // Commission_Deduction
                amount: 0,
                balanceBefore: Number(wallet.balance),
                balanceAfter: Number(wallet.balance),
                description: `[Ưu đãi đối tác mới] Miễn 100% hoa hồng sàn đơn ${booking.bookingCode} (${Math.min(5, previousSuccessfulCount + 1)}/5)`,
              },
            });
          } else {
            const balance = Number(wallet.balance);
            const newBalance = balance - commission;
            await tx.partnerWallet.update({
              where: { id: wallet.id },
              data: { balance: newBalance },
            });
            await tx.walletHistory.create({
              data: {
                walletId: wallet.id,
                bookingId: booking.id,
                type: 1, // Commission_Deduction
                amount: commission,
                balanceBefore: balance,
                balanceAfter: newBalance,
                description: `Khấu trừ hoa hồng sàn đơn ${booking.bookingCode}`,
              },
            });
          }
        }
      }

      return tx.booking.update({
        where: { id: bookingId },
        data: { status: 3 }, // ActiveRental
      });
    });
  }

  /** Flow 6b: Partner xác nhận khách trả xe — hoàn thành đơn */
  async completeBooking(partnerId: number, bookingId: number) {
    return this.prisma.$transaction(async (tx) => {
      // Khóa và đọc lại đơn trong transaction (Chống Race Condition & Double Completion)
      const booking = await tx.booking.findUnique({
        where: { id: bookingId },
        include: { store: true, bookingDetails: { include: { vehicleItem: true } } },
      });
      if (!booking) throw new NotFoundException('Đơn thuê không tồn tại');
      if (booking.store.partnerId !== partnerId)
        throw new ForbiddenException('Đơn thuê không thuộc cửa hàng của bạn');
      if (booking.status !== 3)
        throw new BadRequestException('Đơn phải ở trạng thái ActiveRental (3) mới có thể hoàn thành');

      for (const detail of booking.bookingDetails) {
        if (detail?.vehicleItemId) {
          await tx.vehicleItem.update({
            where: { id: detail.vehicleItemId },
            data: { status: 0 }, // Available
          });
        }
      }

      // Tăng điểm uy tín cửa hàng khi hoàn thành đơn tốt (+1, tối đa 100)
      if (booking.storeId) {
        const curStore = await tx.store.findUnique({
          where: { id: booking.storeId },
          select: { reputationScore: true },
        });
        if (curStore && curStore.reputationScore < 100) {
          await tx.store.update({
            where: { id: booking.storeId },
            data: { reputationScore: { increment: 1 } },
          });
        }
      }

      return tx.booking.update({
        where: { id: bookingId },
        data: { status: 4 }, // Completed
      });
    });
  }

  /** Viết đánh giá chuyến đi (Customer) */
  async createReview(
    customerId: number,
    bookingId: number,
    dto: { rateStar: number; comment?: string },
  ) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: { review: true },
    });
    if (!booking) throw new NotFoundException('Đơn thuê không tồn tại');
    if (booking.customerId !== customerId)
      throw new ForbiddenException('Bạn không có quyền đánh giá đơn này');
    if (booking.status !== 4)
      throw new BadRequestException('Chỉ có thể đánh giá chuyến đi sau khi đã hoàn thành trả xe');
    if (booking.review)
      throw new BadRequestException('Đơn thuê này đã được gửi đánh giá');

    return this.prisma.review.create({
      data: {
        bookingId,
        customerId,
        storeId: booking.storeId,
        rateStar: Math.min(5, Math.max(1, dto.rateStar)),
        comment: dto.comment,
      },
    });
  }

  /** Lấy danh sách đánh giá toàn sàn (Admin) */
  async findAllReviews() {
    return this.prisma.review.findMany({
      include: {
        customer: { select: { fullName: true, phone: true } },
        store: { select: { storeName: true } },
      },
      orderBy: { id: 'desc' },
    });
  }

  /** Ẩn đánh giá vi phạm (Admin) */
  async hideReview(reviewId: number, hiddenReason: string) {
    return this.prisma.review.update({
      where: { id: reviewId },
      data: { isHidden: true, hiddenReason },
    });
  }

  /** Mở lại đánh giá (Admin) */
  async unhideReview(reviewId: number) {
    return this.prisma.review.update({
      where: { id: reviewId },
      data: { isHidden: false, hiddenReason: null },
    });
  }

  /** Thống kê toàn sàn thực tế 100% từ cơ sở dữ liệu (Admin) */
  async getPlatformStats() {
    const [allBookings, allModels, allStores] = await Promise.all([
      this.prisma.booking.findMany({
        include: {
          bookingDetails: {
            include: {
              model: true,
              vehicleItem: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.vehicleModel.findMany({
        include: {
          vehicleItems: true,
        },
      }),
      this.prisma.store.findMany(),
    ]);

    // 1. Doanh thu (GMV) & Hoa hồng thực tế sàn
    // GMV: Tổng rentAmount từ các đơn Confirmed (1), ActiveRental (3), Completed (4)
    const validBookings = allBookings.filter((b) => [1, 3, 4].includes(b.status));
    const totalRevenue = validBookings.reduce(
      (sum, b) => sum + Number(b.rentAmount || 0),
      0
    );

    // Hoa hồng sàn: Khấu trừ khi xe đã được bàn giao cho khách (status 3 hoặc 4)
    const handedOverBookings = allBookings.filter((b) => [3, 4].includes(b.status));
    const totalCommission = handedOverBookings.reduce(
      (sum, b) => sum + Number(b.commissionAmount || 0),
      0
    );

    // 2. Cửa hàng đối tác
    const totalStores = allStores.length;
    const approvedStores = allStores.filter((s) => s.status === 1).length;
    const pendingStores = allStores.filter((s) => s.status === 0).length;
    const rejectedStores = allStores.filter((s) => s.status === 2).length;

    // 3. Đội xe vật lý toàn hệ thống
    const allVehicleItems = allModels.flatMap((m) => m.vehicleItems || []);
    const totalVehicles = allVehicleItems.length;
    const availableVehicles = allVehicleItems.filter((v) => v.status === 0).length;
    const reservedVehicles = allVehicleItems.filter((v) => v.status === 1).length;
    const rentedVehicles = allVehicleItems.filter((v) => v.status === 2).length;
    const maintenanceVehicles = allVehicleItems.filter((v) => v.status === 3).length;
    const occupancyRate =
      totalVehicles > 0 ? Math.round((rentedVehicles / totalVehicles) * 100) : 0;

    // 4. Phân bổ trạng thái đơn đặt
    // 0: PendingPayment, 1: Confirmed, 2: WaitingQueue, 3: ActiveRental, 4: Completed, 5: Cancelled
    const statusCounts: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const b of allBookings) {
      if (statusCounts[b.status] !== undefined) {
        statusCounts[b.status]++;
      }
    }
    const totalB = allBookings.length;
    const bookingStatusBreakdown = [
      {
        name: 'Đã hoàn tất',
        status: 4,
        count: statusCounts[4],
        value: totalB > 0 ? Math.round((statusCounts[4] / totalB) * 100) : 0,
        color: '#10B981', // emerald
      },
      {
        name: 'Đang cho thuê',
        status: 3,
        count: statusCounts[3],
        value: totalB > 0 ? Math.round((statusCounts[3] / totalB) * 100) : 0,
        color: '#3B82F6', // blue
      },
      {
        name: 'Chờ bàn giao',
        status: 1,
        count: statusCounts[1],
        value: totalB > 0 ? Math.round((statusCounts[1] / totalB) * 100) : 0,
        color: '#06B6D4', // cyan
      },
      {
        name: 'Hàng chờ FIFO',
        status: 2,
        count: statusCounts[2],
        value: totalB > 0 ? Math.round((statusCounts[2] / totalB) * 100) : 0,
        color: '#8B5CF6', // purple
      },
      {
        name: 'Chờ thanh toán',
        status: 0,
        count: statusCounts[0],
        value: totalB > 0 ? Math.round((statusCounts[0] / totalB) * 100) : 0,
        color: '#F59E0B', // amber
      },
      {
        name: 'Đã hủy',
        status: 5,
        count: statusCounts[5],
        value: totalB > 0 ? Math.round((statusCounts[5] / totalB) * 100) : 0,
        color: '#EF4444', // rose
      },
    ];

    // 5. Phân bổ theo loại phương tiện
    // 0: Xe số, 1: Tay ga, 2: Côn tay, 3: Xe điện, 4: Ô tô tự lái
    const typeNames: Record<number, string> = {
      0: 'Xe số',
      1: 'Xe tay ga',
      2: 'Xe tay côn',
      3: 'Xe điện',
      4: 'Ô tô',
      5: 'Ô tô điện',
    };
    const vehicleCategoryDistribution = [0, 1, 2, 3, 4, 5].map((type) => {
      const modelsOfType = allModels.filter((m) => m.type === type);
      const items = modelsOfType.flatMap((m) => m.vehicleItems || []);
      const total = items.length;
      const rented = items.filter((i) => i.status === 2).length;
      return {
        category: typeNames[type] || `Loại ${type}`,
        type,
        total,
        rented,
      };
    });

    // 6. Doanh thu & hoa hồng 6 tháng gần nhất thực tế
    const now = new Date();
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const y = d.getFullYear();
      const m = d.getMonth() + 1;
      const monthLabel = `T${m}/${y}`;

      const monthBookings = allBookings.filter((b) => {
        const bDate = new Date(b.createdAt);
        return bDate.getFullYear() === y && bDate.getMonth() + 1 === m;
      });

      const monthValidBookings = monthBookings.filter((b) => [1, 3, 4].includes(b.status));
      const monthHandedOver = monthBookings.filter((b) => [3, 4].includes(b.status));

      const rev = monthValidBookings.reduce((sum, b) => sum + Number(b.rentAmount || 0), 0);
      const comm = monthHandedOver.reduce((sum, b) => sum + Number(b.commissionAmount || 0), 0);

      months.push({
        month: monthLabel,
        revenue: rev,
        commission: comm,
        bookings: monthBookings.length,
      });
    }

    return {
      totalRevenue,
      totalCommission,
      totalBookings: allBookings.length,
      totalStores,
      approvedStores,
      pendingStores,
      rejectedStores,
      totalVehicles,
      availableVehicles,
      rentedVehicles,
      reservedVehicles,
      maintenanceVehicles,
      occupancyRate,
      revenueTrend: months,
      bookingStatusBreakdown,
      vehicleCategoryDistribution,
    };
  }

  /** Lấy toàn bộ đơn thuê toàn hệ thống (Admin) */
  async findAllBookingsForAdmin() {
    return this.prisma.booking.findMany({
      include: {
        customer: { select: { id: true, fullName: true, email: true, phone: true } },
        store: { select: { id: true, storeName: true, address: true, phoneContact: true } },
        bookingDetails: {
          include: {
            model: { select: { id: true, name: true, brand: true, type: true, rentPrice: true } },
            vehicleItem: { select: { id: true, licensePlate: true, color: true } },
          },
        },
        payments: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Tạo đơn thuê trực tiếp tại quầy cho khách vãng lai (Walk-in Booking) */
  async createWalkInBooking(partnerId: number, dto: CreateWalkInBookingDto) {
    // 1. Kiểm tra quyền sở hữu chi nhánh
    const store = await this.prisma.store.findUnique({
      where: { id: dto.storeId },
      include: { rentalPolicy: true },
    });
    if (!store) throw new NotFoundException('Chi nhánh không tồn tại');
    if (store.partnerId !== partnerId) {
      throw new ForbiddenException('Chi nhánh không thuộc quyền quản lý của bạn');
    }
    if (store.status !== 1) {
      throw new BadRequestException('Chi nhánh đang tạm ngừng hoặc chưa được duyệt, không thể tạo đơn');
    }

    // 2. Kiểm tra dòng xe & xe vật lý
    const itemIds: number[] = Array.isArray(dto.vehicleItemIds) && dto.vehicleItemIds.length > 0
      ? dto.vehicleItemIds
      : (dto.vehicleItemId ? [dto.vehicleItemId] : []);

    if (itemIds.length === 0) {
      throw new BadRequestException('Vui lòng chọn ít nhất một xe vật lý bàn giao');
    }

    const vehicleItems = await this.prisma.vehicleItem.findMany({
      where: { id: { in: itemIds } },
      include: { model: true },
    });

    if (vehicleItems.length !== itemIds.length) {
      throw new NotFoundException('Một hoặc nhiều xe vật lý được chọn không tồn tại');
    }

    for (const item of vehicleItems) {
      if (item.model.storeId !== dto.storeId || item.modelId !== dto.modelId) {
        throw new BadRequestException(`Xe biển số ${item.licensePlate} không thuộc dòng xe hoặc chi nhánh đã chọn`);
      }
      if (item.status !== 0) {
        const stText = item.status === 1 ? 'đang giữ chỗ' : item.status === 2 ? 'đang cho thuê' : 'đang bảo dưỡng';
        throw new BadRequestException(`Xe biển số ${item.licensePlate} hiện ${stText}, không thể gán cho đơn mới`);
      }
    }

    // 3. Kiểm tra thời gian
    const start = new Date(dto.startTime);
    const end = new Date(dto.endTime);
    if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) {
      throw new BadRequestException('Thời gian trả xe phải sau thời gian nhận xe');
    }

    // 4. Tính toán số ngày và tiền tệ (Hỗ trợ định giá bậc thang theo số ngày thuê)
    const diffHours = (end.getTime() - start.getTime()) / (1000 * 60 * 60);
    const rentDays = Math.max(1, Math.ceil(diffHours / 24));
    const model = vehicleItems[0].model;
    const baseRentPrice = Number(model.rentPrice);
    const pricePerUnit = getTieredPricePerDay(baseRentPrice, (model as any).pricingTiers, rentDays);
    const calculatedTotal = rentDays * pricePerUnit * vehicleItems.length;
    const totalRentAmount = calculatedTotal;
    const depositAmount = dto.depositAmount !== undefined ? Number(dto.depositAmount) : 0;

    // Ưu đãi đối tác mới: 5 đơn thành công đầu tiên (status in [1, 3, 4]) được miễn 100% hoa hồng sàn (0đ)
    const sysConfig = await this.prisma.systemConfig.findFirst();
    const sysCommissionRate = sysConfig ? Number(sysConfig.commissionRate) / 100 : 0.10;
    const partnerSuccessfulBookingsCount = await this.prisma.booking.count({
      where: {
        store: { partnerId },
        status: { in: [1, 3, 4] },
      },
    });
    const isFreeCommission = partnerSuccessfulBookingsCount < 5;
    const commissionAmount = isFreeCommission ? 0 : Math.round(totalRentAmount * sysCommissionRate);

    // 5. Tìm hoặc tạo Customer user cho khách vãng lai
    const phoneClean = dto.customerPhone.trim();
    let customer = await this.prisma.user.findFirst({
      where: { phone: phoneClean },
    });
    if (!customer && dto.customerEmail) {
      customer = await this.prisma.user.findUnique({
        where: { email: dto.customerEmail.trim() },
      });
    }

    if (!customer) {
      const randomSuffix = Math.random().toString(36).substring(2, 7);
      const generatedEmail = dto.customerEmail?.trim() || `walkin_${phoneClean.replace(/\D/g, '') || randomSuffix}@vehiclerent.local`;
      const tempPasswordHash = await bcrypt.hash(`WalkIn@${phoneClean.slice(-4) || '2026'}`, 10);

      customer = await this.prisma.user.create({
        data: {
          fullName: dto.customerName.trim(),
          phone: phoneClean,
          email: generatedEmail,
          passwordHash: tempPasswordHash,
          role: 2, // Customer
          driverLicense: dto.driverLicense?.trim() || undefined,
        },
      });
    } else if (dto.driverLicense && !customer.driverLicense) {
      await this.prisma.user.update({
        where: { id: customer.id },
        data: { driverLicense: dto.driverLicense.trim() },
      });
    }

    // 6. Tạo đơn trong transaction
    const handoverNow = dto.handoverNow !== false; // Mặc định bàn giao ngay
    const newBookingStatus = handoverNow ? 3 : 1; // 3: ActiveRental, 1: Confirmed
    const newVehicleStatus = handoverNow ? 2 : 1; // 2: Rented, 1: Reserved
    const bookingCode = `VR-WALK-${Date.now().toString().slice(-6)}-${Math.floor(100 + Math.random() * 900)}`;

    return this.prisma.$transaction(async (tx) => {
      const booking = await tx.booking.create({
        data: {
          bookingCode,
          customerId: customer.id,
          storeId: dto.storeId,
          startTime: start,
          endTime: end,
          dayRent: rentDays,
          rentAmount: totalRentAmount,
          depositAmount: depositAmount,
          commissionAmount: commissionAmount,
          status: newBookingStatus,
        },
      });

      const subTotalPerItem = rentDays * pricePerUnit;
      for (const item of vehicleItems) {
        await tx.bookingDetail.create({
          data: {
            bookingId: booking.id,
            modelId: dto.modelId,
            vehicleItemId: item.id,
            quantity: 1,
            pricePerUnit: pricePerUnit,
            subTotal: subTotalPerItem,
          },
        });

        const allocated = await tx.vehicleItem.updateMany({
          where: { id: item.id, status: 0 },
          data: { status: newVehicleStatus },
        });
        if (allocated.count === 0) {
          throw new ConflictException(`Xe biển số ${item.licensePlate} không còn khả dụng hoặc vừa được gán cho đơn khác.`);
        }
      }

      // Tạo bản ghi Payment
      await tx.payment.create({
        data: {
          bookingId: booking.id,
          amount: handoverNow ? totalRentAmount : (depositAmount > 0 ? depositAmount : totalRentAmount),
          paymentMethod: 0, // 0: Cash / Tiền mặt
          paymentType: handoverNow ? 0 : (depositAmount > 0 ? 1 : 0), // 0: FullPayment, 1: DepositOnly
          paymentStatus: 1, // 1: Success
          paymentTime: new Date(),
          transactionRef: `PAY-WALK-${booking.id}-${Date.now().toString().slice(-4)}`,
        },
      });

      // Nếu bàn giao ngay: xử lý hoa hồng ví đối tác
      if (handoverNow) {
        const wallet = await tx.partnerWallet.findUnique({
          where: { partnerId },
        });
        if (wallet) {
          if (commissionAmount === 0) {
            // Ưu đãi đối tác mới: ghi nhận 0đ hoa hồng
            await tx.walletHistory.create({
              data: {
                walletId: wallet.id,
                bookingId: booking.id,
                type: 1, // Commission_Deduction
                amount: 0,
                balanceBefore: Number(wallet.balance),
                balanceAfter: Number(wallet.balance),
                description: `[Ưu đãi đối tác mới] Miễn 100% hoa hồng sàn đơn tại quầy ${booking.bookingCode} (${Math.min(5, partnerSuccessfulBookingsCount + 1)}/5)`,
              },
            });
          } else {
            const balance = Number(wallet.balance);
            const newBalance = balance - commissionAmount;
            await tx.partnerWallet.update({
              where: { id: wallet.id },
              data: { balance: newBalance },
            });
            await tx.walletHistory.create({
              data: {
                walletId: wallet.id,
                bookingId: booking.id,
                type: 1, // Commission_Deduction
                amount: commissionAmount,
                balanceBefore: balance,
                balanceAfter: newBalance,
                description: `Khấu trừ hoa hồng sàn đơn tại quầy ${booking.bookingCode}`,
              },
            });
          }
        }
      }

      return booking;
    });
  }

  // ─── KHÁCH KHÔNG ĐẾN NHẬN XE & HỦY ĐƠN (CHỨC NĂNG 1) ─────────────────────────────

  /** Đối tác hủy đơn do khách không đến nhận xe sau khi hết ngày hẹn */
  async noShowByStore(partnerId: number, bookingId: number) {
    return this.prisma.$transaction(async (tx) => {
      const booking = await tx.booking.findUnique({
        where: { id: bookingId },
        include: { store: true, bookingDetails: true },
      });
      if (!booking) throw new NotFoundException('Đơn thuê không tồn tại');
      if (booking.store.partnerId !== partnerId) {
        throw new ForbiddenException('Đơn thuê không thuộc cửa hàng của bạn');
      }
      if (booking.status !== 1) {
        throw new BadRequestException('Chỉ có thể xác nhận khách không đến với đơn đang ở trạng thái Chờ nhận xe (Confirmed)');
      }

      // Kiểm tra đơn đã thanh toán 100% chưa
      // Đơn đã thanh toán 100% bắt buộc giữ xe hết kỳ thuê
      const isFullPayment = Number(booking.depositAmount) >= Number(booking.rentAmount);
      if (isFullPayment) {
        throw new BadRequestException(
          'Đơn này đã thanh toán 100% tiền thuê. Theo quy định của sàn, nhà xe bắt buộc phải giữ xe cho khách trong suốt toàn bộ thời gian thuê, không được hủy đơn giải phóng xe.',
        );
      }

      // Kiểm tra thời gian: Chỉ được hủy đơn sau khi ĐÃ HẾT NGÀY HẸN NHẬN XE
      const now = new Date();
      const startTime = new Date(booking.startTime);

      // Tính thời điểm kết thúc ngày nhận xe (23:59:59.999 của ngày hẹn nhận theo giờ Việt Nam UTC+7)
      const vnTimeOffset = 7 * 60 * 60 * 1000;
      const startVnTime = new Date(startTime.getTime() + vnTimeOffset);
      const startYear = startVnTime.getUTCFullYear();
      const startMonth = startVnTime.getUTCMonth();
      const startDate = startVnTime.getUTCDate();

      const endOfPickupDayUtc = new Date(Date.UTC(startYear, startMonth, startDate, 23, 59, 59, 999) - vnTimeOffset);

      if (now < endOfPickupDayUtc) {
        const pad = (n: number) => String(n).padStart(2, '0');
        const formattedDate = `${pad(startDate)}/${pad(startMonth + 1)}/${startYear}`;
        throw new BadRequestException(
          `Chưa hết ngày hẹn nhận xe (${formattedDate}). Nhà xe chỉ được hủy đơn sau khi kết thúc ngày hẹn nhận xe mà khách vẫn không đến nhận.`,
        );
      }

      // 1. Giải phóng xe vật lý đã giữ về trạng thái Sẵn sàng (0)
      for (const detail of booking.bookingDetails) {
        if (detail.vehicleItemId) {
          await tx.vehicleItem.updateMany({
            where: { id: detail.vehicleItemId, status: 1 },
            data: { status: 0 },
          });
        }
      }

      // 2. Chuyển trạng thái đơn sang Đã hủy (status = 5), cancelType = 2 (Khách không đến)
      // Cửa hàng giữ cọc (refundStatus = 2), KHÔNG TRỪ UY TÍN
      return tx.booking.update({
        where: { id: bookingId },
        data: {
          status: 5,
          cancelType: 2, // Khách không đến
          cancelReason: 'Khách không đến nhận xe sau khi kết thúc ngày hẹn • Cửa hàng giữ cọc theo quy định',
          cancelTime: now,
          refundStatus: 2, // Nhà xe giữ cọc
          refundAmount: 0,
        },
      });
    });
  }

  /** Đối tác tự hủy đơn vì hết xe / không có xe giao */
  async cancelByStore(
    partnerId: number,
    bookingId: number,
    dto: { reason: string; isForceMajeure?: boolean; forceMajeureProof?: string },
  ) {
    return this.prisma.$transaction(async (tx) => {
      const booking = await tx.booking.findUnique({
        where: { id: bookingId },
        include: { store: true, bookingDetails: true },
      });
      if (!booking) throw new NotFoundException('Đơn thuê không tồn tại');
      if (booking.store.partnerId !== partnerId) {
        throw new ForbiddenException('Đơn thuê không thuộc cửa hàng của bạn');
      }
      if (booking.status !== 1 && booking.status !== 2) {
        throw new BadRequestException('Chỉ có thể hủy đơn đang chờ nhận xe hoặc trong hàng chờ');
      }
      if (!dto?.reason?.trim()) {
        throw new BadRequestException('Vui lòng cung cấp lý do cửa hàng không thể giao xe');
      }

      const now = new Date();
      const depositAmt = Number(booking.depositAmount);

      // Bồi thường 20% tiền cọc (hoặc tối thiểu 50.000đ)
      const compensation = depositAmt > 0 ? Math.max(50000, Math.round(depositAmt * 0.2)) : 0;
      const totalRefund = depositAmt + compensation; // 100% cọc + 20% bồi thường

      // 1. Giải phóng xe vật lý về 0
      for (const detail of booking.bookingDetails) {
        if (detail.vehicleItemId) {
          await tx.vehicleItem.updateMany({
            where: { id: detail.vehicleItemId, status: 1 },
            data: { status: 0 },
          });
        }
      }

      // 2. Khấu trừ ví đối tác: tổng tiền hoàn 100% cọc + bồi thường 20%
      if (totalRefund > 0) {
        const wallet = await tx.partnerWallet.findUnique({
          where: { partnerId },
        });
        if (wallet) {
          const curBal = Number(wallet.balance);
          const newBal = curBal - totalRefund;
          await tx.partnerWallet.update({
            where: { id: wallet.id },
            data: { balance: newBal },
          });
          await tx.walletHistory.create({
            data: {
              walletId: wallet.id,
              bookingId: booking.id,
              type: 2, // Refund / Compensation Deduction
              amount: totalRefund,
              balanceBefore: curBal,
              balanceAfter: newBal,
              description: `Khấu trừ hoàn cọc (${depositAmt.toLocaleString('vi-VN')} đ) + bồi thường 20% (${compensation.toLocaleString('vi-VN')} đ) đơn ${booking.bookingCode} do cửa hàng hủy`,
            },
          });
        }
      }

      // 3. Trừ điểm uy tín cửa hàng (trừ 10 điểm, tối thiểu 0) nếu KHÔNG phải bất khả kháng
      if (!dto.isForceMajeure && booking.storeId) {
        const curStore = await tx.store.findUnique({
          where: { id: booking.storeId },
          select: { reputationScore: true },
        });
        if (curStore) {
          const newScore = Math.max(0, curStore.reputationScore - 10);
          await tx.store.update({
            where: { id: booking.storeId },
            data: { reputationScore: newScore },
          });
        }
      }

      // 4. Cập nhật booking sang Đã hủy (status = 5)
      return tx.booking.update({
        where: { id: bookingId },
        data: {
          status: 5,
          cancelType: 3, // Cửa hàng tự hủy
          cancelReason: `Cửa hàng tự hủy: ${dto.reason.trim()}${dto.isForceMajeure ? ' [Đính kèm giải trình bất khả kháng]' : ''}`,
          cancelTime: now,
          compensationAmount: compensation,
          isForceMajeure: Boolean(dto.isForceMajeure),
          forceMajeureProof: dto.forceMajeureProof?.trim() || null,
          refundStatus: totalRefund > 0 ? 0 : 2, // 0: Chờ Admin/Sàn chuyển khoản hoàn cọc + bồi thường cho khách
          refundAmount: totalRefund,
        },
      });
    });
  }

  // ─── BÁO SỰ CỐ TỪ KHÁCH HÀNG (CHỨC NĂNG 2) ────────────────────────────────

  /** Khách hàng báo sự cố nhà xe không có xe khi sát hoặc đã tới giờ nhận */
  async reportIssueByCustomer(
    customerId: number,
    bookingId: number,
    dto: { reason: string; bankName?: string; bankAccountNumber?: string; bankAccountName?: string },
  ) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: { store: true },
    });
    if (!booking) throw new NotFoundException('Đơn thuê không tồn tại');
    if (booking.customerId !== customerId) {
      throw new ForbiddenException('Bạn không có quyền báo cáo sự cố cho đơn này');
    }
    if (booking.status !== 1) {
      throw new BadRequestException('Chỉ có thể báo sự cố đối với đơn đang ở trạng thái Chờ nhận xe');
    }

    // Điều kiện thời gian: Sát giờ nhận xe (trong vòng 2h trước) hoặc đã quá giờ hẹn nhận xe
    const now = new Date();
    const startTime = new Date(booking.startTime);
    const diffHours = (startTime.getTime() - now.getTime()) / (1000 * 60 * 60);

    if (diffHours > 2) {
      throw new BadRequestException(
        'Chức năng Báo sự cố chỉ khả dụng trong vòng 2 giờ trước giờ nhận xe hoặc sau khi đã tới giờ hẹn mà nhà xe không giao xe.',
      );
    }

    if (!dto?.reason?.trim()) {
      throw new BadRequestException('Vui lòng nêu rõ sự cố gặp phải với nhà xe');
    }

    return this.prisma.booking.update({
      where: { id: bookingId },
      data: {
        disputeStatus: 1, // Chờ Admin đối soát
        disputeReason: dto.reason.trim(),
        disputeCreatedAt: now,
        refundBankName: dto?.bankName?.trim() || booking.refundBankName,
        refundAccountNumber: dto?.bankAccountNumber?.trim() || booking.refundAccountNumber,
        refundAccountName: dto?.bankAccountName?.trim()?.toUpperCase() || booking.refundAccountName,
      },
    });
  }

  /** Admin đối soát tranh chấp: Duyệt bồi thường 100% cọc + 20% cho khách hoặc xác nhận bất khả kháng */
  async adminResolveDispute(
    bookingId: number,
    dto: { isStoreFault: boolean; note?: string },
  ) {
    return this.prisma.$transaction(async (tx) => {
      const booking = await tx.booking.findUnique({
        where: { id: bookingId },
        include: { store: true, bookingDetails: true },
      });
      if (!booking) throw new NotFoundException('Đơn thuê không tồn tại');
      if (booking.disputeStatus !== 1) {
        throw new BadRequestException('Đơn không ở trạng thái chờ đối soát tranh chấp');
      }

      const now = new Date();

      if (dto.isStoreFault) {
        // Đúng lỗi cửa hàng: Hoàn 100% cọc + Bồi thường 20% (min 50k)
        const depositAmt = Number(booking.depositAmount);
        const compensation = depositAmt > 0 ? Math.max(50000, Math.round(depositAmt * 0.2)) : 0;
        const totalRefund = depositAmt + compensation;

        // Giải phóng xe nếu còn giữ
        for (const detail of booking.bookingDetails) {
          if (detail.vehicleItemId) {
            await tx.vehicleItem.updateMany({
              where: { id: detail.vehicleItemId, status: 1 },
              data: { status: 0 },
            });
          }
        }

        // Khấu trừ ví đối tác
        if (totalRefund > 0) {
          const wallet = await tx.partnerWallet.findUnique({
            where: { partnerId: booking.store.partnerId },
          });
          if (wallet) {
            const curBal = Number(wallet.balance);
            const newBal = curBal - totalRefund;
            await tx.partnerWallet.update({
              where: { id: wallet.id },
              data: { balance: newBal },
            });
            await tx.walletHistory.create({
              data: {
                walletId: wallet.id,
                bookingId: booking.id,
                type: 2,
                amount: totalRefund,
                balanceBefore: curBal,
                balanceAfter: newBal,
                description: `Admin đối soát: Khấu trừ hoàn cọc + bồi thường 20% đơn ${booking.bookingCode} do lỗi nhà xe`,
              },
            });
          }
        }

        // Trừ điểm uy tín cửa hàng (-10 điểm)
        if (booking.storeId) {
          const curStore = await tx.store.findUnique({
            where: { id: booking.storeId },
            select: { reputationScore: true },
          });
          if (curStore) {
            await tx.store.update({
              where: { id: booking.storeId },
              data: { reputationScore: Math.max(0, curStore.reputationScore - 10) },
            });
          }
        }

        return tx.booking.update({
          where: { id: bookingId },
          data: {
            status: 5, // Cancelled
            cancelType: 3, // Cửa hàng lỗi không giao xe
            cancelReason: `Admin xử lý tranh chấp: Nhà xe không có xe giao (${dto.note || 'Lỗi cửa hàng'})`,
            cancelTime: now,
            disputeStatus: 2, // Resolved_Refunded
            compensationAmount: compensation,
            refundStatus: 0, // Chờ chuyển khoản
            refundAmount: totalRefund,
          },
        });
      } else {
        // Cửa hàng chứng minh bất khả kháng hoặc không phải lỗi nhà xe: Miễn phạt
        return tx.booking.update({
          where: { id: bookingId },
          data: {
            disputeStatus: 3, // Resolved_Exempt (Miễn phạt)
            cancelReason: booking.cancelReason
              ? `${booking.cancelReason} • [Admin: ${dto.note || 'Miễn phạt do sự cố bất khả kháng'}]`
              : `[Admin: ${dto.note || 'Miễn phạt do sự cố bất khả kháng'}]`,
          },
        });
      }
    });
  }

  // ─── QUẢN LÝ ẢNH CCCD BẢN GIAO XE - NGHỊ ĐỊNH 13 (CHỨC NĂNG 3) ────────────

  /** Lưu ảnh CCCD lúc bàn giao xe */
  async saveIdCard(
    partnerId: number,
    bookingId: number,
    dto: { idCardFront: string; idCardBack: string },
  ) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: { store: true },
    });
    if (!booking) throw new NotFoundException('Đơn thuê không tồn tại');
    if (booking.store.partnerId !== partnerId) {
      throw new ForbiddenException('Bạn không có quyền quản lý đơn thuê này');
    }
    if (!dto.idCardFront?.trim() || !dto.idCardBack?.trim()) {
      throw new BadRequestException('Vui lòng tải lên đầy đủ ảnh CCCD 2 mặt (mặt trước và mặt sau)');
    }

    return this.prisma.booking.update({
      where: { id: bookingId },
      data: {
        idCardFront: dto.idCardFront.trim(),
        idCardBack: dto.idCardBack.trim(),
        idCardCapturedAt: new Date(),
        idCardDeletedAt: null,
      },
      select: {
        id: true,
        bookingCode: true,
        idCardFront: true,
        idCardBack: true,
        idCardCapturedAt: true,
      },
    });
  }

  /** Xem ảnh CCCD (Chỉ chủ cửa hàng và Admin được quyền xem - Chuẩn NĐ 13) */
  async getIdCard(userId: number, role: number, bookingId: number) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: { store: true },
    });
    if (!booking) throw new NotFoundException('Đơn thuê không tồn tại');

    // Phân quyền nghiêm ngặt theo Nghị định 13/2023/NĐ-CP:
    // Chỉ Admin (role 0) hoặc chính chủ cửa hàng của đơn đó (role 1 & partnerId == userId)
    const isAdmin = role === 0;
    const isOwnerPartner = role === 1 && booking.store.partnerId === userId;
    const isCustomer = role === 2 && booking.customerId === userId;

    if (!isAdmin && !isOwnerPartner && !isCustomer) {
      throw new ForbiddenException(
        'Quyền riêng tư: Chỉ chủ cửa hàng quản lý đơn và Quản trị viên mới được phép xem ảnh CCCD (Nghị định 13/2023/NĐ-CP).',
      );
    }

    if (booking.idCardDeletedAt) {
      return {
        isDeleted: true,
        message: 'Ảnh CCCD đã được hệ thống tự động xóa vĩnh viễn sau 30 ngày theo quy định bảo mật Nghị định 13/2023/NĐ-CP.',
        deletedAt: booking.idCardDeletedAt,
      };
    }

    return {
      isDeleted: false,
      idCardFront: booking.idCardFront,
      idCardBack: booking.idCardBack,
      idCardCapturedAt: booking.idCardCapturedAt,
    };
  }

  /** Cron: Tự động xóa ảnh CCCD sau 30 ngày kể từ khi đơn hoàn thành hoặc đã hủy */
  async cleanupExpiredIdCards() {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    return this.prisma.booking.updateMany({
      where: {
        status: { in: [4, 5] }, // Completed hoặc Cancelled
        createdAt: { lt: thirtyDaysAgo },
        OR: [
          { idCardFront: { not: null } },
          { idCardBack: { not: null } },
        ],
        idCardDeletedAt: null,
      },
      data: {
        idCardFront: null,
        idCardBack: null,
        idCardDeletedAt: new Date(),
      },
    });
  }
}


