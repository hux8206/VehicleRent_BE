import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreatePromotionDto } from './dto/create-promotion.dto';
import { ValidatePromotionDto } from './dto/validate-promotion.dto';

@Injectable()
export class PromotionsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Lấy danh sách khuyến mãi đang hoạt động (Public cho Khách hàng & Trang chủ)
   */
  async findActivePublic() {
    return this.prisma.promotion.findMany({
      where: {
        isActive: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Lấy toàn bộ danh sách khuyến mãi (Dành cho Admin)
   */
  async findAllAdmin() {
    return this.prisma.promotion.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Tạo khuyến mãi mới (Admin)
   */
  async create(dto: CreatePromotionDto) {
    const code = dto.code.trim().toUpperCase();

    const existing = await this.prisma.promotion.findUnique({
      where: { code },
    });
    if (existing) {
      throw new ConflictException(`Mã khuyến mãi "${code}" đã tồn tại trong hệ thống!`);
    }

    return this.prisma.promotion.create({
      data: {
        code,
        title: dto.title.trim(),
        description: dto.description?.trim(),
        discountType: dto.discountType,
        discountValue: dto.discountValue,
        minRentDays: dto.minRentDays || 1,
        maxDiscount: dto.maxDiscount || null,
        tag: dto.tag?.trim() || null,
        bullets: dto.bullets || [],
        usageLimit: dto.usageLimit !== undefined ? dto.usageLimit : 1000,
        isActive: dto.isActive !== undefined ? dto.isActive : true,
      },
    });
  }

  /**
   * Bật / Tắt trạng thái khuyến mãi (Admin)
   */
  async toggleActive(id: number) {
    const promo = await this.prisma.promotion.findUnique({
      where: { id },
    });
    if (!promo) {
      throw new NotFoundException('Không tìm thấy chương trình khuyến mãi');
    }

    return this.prisma.promotion.update({
      where: { id },
      data: { isActive: !promo.isActive },
    });
  }

  /**
   * Xóa khuyến mãi (Admin)
   */
  async delete(id: number) {
    const promo = await this.prisma.promotion.findUnique({
      where: { id },
    });
    if (!promo) {
      throw new NotFoundException('Không tìm thấy chương trình khuyến mãi');
    }

    return this.prisma.promotion.delete({
      where: { id },
    });
  }

  /**
   * Kiểm tra và tính toán giảm giá thử nghiệm trước khi chốt đơn
   */
  async validate(dto: ValidatePromotionDto) {
    const code = dto.code.trim().toUpperCase();
    const promo = await this.prisma.promotion.findUnique({
      where: { code },
    });

    if (!promo || !promo.isActive) {
      throw new BadRequestException('Mã khuyến mãi không tồn tại hoặc đã bị vô hiệu hóa');
    }
    if (promo.endDate && promo.endDate < new Date()) {
      throw new BadRequestException('Mã khuyến mãi đã hết thời hạn sử dụng');
    }
    if (promo.usageLimit !== null && promo.usedCount >= promo.usageLimit) {
      throw new BadRequestException('Mã khuyến mãi đã đạt số lượt sử dụng tối đa');
    }
    if (promo.minRentDays && dto.dayRent < promo.minRentDays) {
      throw new BadRequestException(
        `Mã "${promo.code}" yêu cầu lịch trình thuê xe tối thiểu từ ${promo.minRentDays} ngày trở lên`,
      );
    }

    let discountAmount = 0;
    if (promo.discountType === 0) {
      // Giảm %
      const pct = Number(promo.discountValue);
      let disc = (dto.rentAmount * pct) / 100;
      if (promo.maxDiscount) {
        disc = Math.min(disc, Number(promo.maxDiscount));
      }
      discountAmount = Math.round(disc);
    } else {
      // Giảm tiền cố định
      discountAmount = Math.min(dto.rentAmount, Number(promo.discountValue));
    }

    return {
      valid: true,
      code: promo.code,
      title: promo.title,
      discountType: promo.discountType,
      discountValue: Number(promo.discountValue),
      discountAmount,
      finalRentAmount: Math.max(0, dto.rentAmount - discountAmount),
      message: `Áp dụng thành công mã ${promo.code}! Giảm ${discountAmount.toLocaleString('vi-VN')} đ`,
    };
  }
}

