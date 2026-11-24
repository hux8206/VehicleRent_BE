import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { calculateHaversineDistance } from '../common/utils/geo.util';
import { CreateVehicleModelDto } from './dto/create-vehicle-model.dto';
import { UpdateVehicleModelDto } from './dto/update-vehicle-model.dto';
import { CreateVehicleItemDto } from './dto/create-vehicle-item.dto';
import { UpdateVehicleItemDto } from './dto/update-vehicle-item.dto';
import { UpdateVehicleItemStatusDto } from './dto/update-vehicle-item-status.dto';
import { SearchVehiclesDto } from './dto/search-vehicles.dto';
import { Prisma } from '@prisma/client';

@Injectable()
export class VehiclesService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── PARTNER: VehicleModel CRUD ─────────────────────────────────────────────

  validatePricingTiers(tiers: any) {
    if (tiers === null || tiers === undefined) return;
    if (!Array.isArray(tiers)) {
      throw new BadRequestException('Bảng giá bậc thang phải là một danh sách các mốc');
    }
    if (tiers.length === 0) return;

    for (const tier of tiers) {
      if (typeof tier !== 'object' || tier === null) {
        throw new BadRequestException('Mốc giá bậc thang không hợp lệ');
      }
      const minDays = Number(tier.minDays);
      const pricePerDay = Number(tier.pricePerDay);
      if (!Number.isInteger(minDays) || minDays < 1) {
        throw new BadRequestException('Số ngày bắt đầu (Từ ngày) của mốc giá phải là số nguyên dương (>= 1)');
      }
      if (isNaN(pricePerDay) || pricePerDay <= 0) {
        throw new BadRequestException('Đơn giá thuê mỗi ngày của từng mốc phải lớn hơn 0');
      }
      if (tier.maxDays !== null && tier.maxDays !== undefined && tier.maxDays !== '') {
        const maxDays = Number(tier.maxDays);
        if (!Number.isInteger(maxDays) || maxDays < minDays) {
          throw new BadRequestException(`Số ngày kết thúc (${maxDays}) phải lớn hơn hoặc bằng số ngày bắt đầu (${minDays})`);
        }
      }
    }

    // Kiểm tra không chồng chéo khoảng ngày
    const sorted = [...tiers].sort((a, b) => Number(a.minDays) - Number(b.minDays));
    for (let i = 0; i < sorted.length; i++) {
      const current = sorted[i];
      const curMin = Number(current.minDays);
      const curMax = current.maxDays !== null && current.maxDays !== undefined && current.maxDays !== ''
        ? Number(current.maxDays)
        : null;

      if (i > 0) {
        const prev = sorted[i - 1];
        const prevMin = Number(prev.minDays);
        const prevMax = prev.maxDays !== null && prev.maxDays !== undefined && prev.maxDays !== ''
          ? Number(prev.maxDays)
          : null;

        if (prevMax === null) {
          throw new BadRequestException(`Mốc [Từ ngày ${prevMin} trở lên] đã bao gồm tất cả các ngày sau đó, không thể thêm mốc [Từ ngày ${curMin}]`);
        }
        if (curMin <= prevMax) {
          throw new BadRequestException(`Khoảng ngày bị chồng chéo: [${prevMin} - ${prevMax}] và [${curMin} - ${curMax || 'trở lên'}]`);
        }
      }
    }
  }

  async createModel(partnerId: number, dto: CreateVehicleModelDto) {
    await this.assertStoreOwnership(partnerId, dto.storeId);
    if (dto.pricingTiers) {
      this.validatePricingTiers(dto.pricingTiers);
    }
    return this.prisma.vehicleModel.create({
      data: {
        storeId: dto.storeId,
        name: dto.name,
        brand: dto.brand,
        type: dto.type,
        rentPrice: dto.rentPrice,
        specifications: dto.specifications,
        images: dto.images ? dto.images : undefined,
        pricingTiers: dto.pricingTiers !== undefined ? (dto.pricingTiers as any) : undefined,
      },
    });
  }

  async findAllModels(partnerId: number, storeId?: number) {
    if (storeId) {
      await this.assertStoreOwnership(partnerId, storeId);
      return this.prisma.vehicleModel.findMany({
        where: { storeId },
        include: {
          store: true,
          vehicleItems: true,
          _count: { select: { vehicleItems: true } },
        },
      });
    }

    const partnerStores = await this.prisma.store.findMany({
      where: { partnerId },
      select: { id: true },
    });
    const storeIds = partnerStores.map((s) => s.id);

    return this.prisma.vehicleModel.findMany({
      where: { storeId: { in: storeIds } },
      include: {
        store: true,
        vehicleItems: true,
        _count: { select: { vehicleItems: true } },
      },
    });
  }

  async findOneModel(partnerId: number, modelId: number) {
    const model = await this.prisma.vehicleModel.findUnique({
      where: { id: modelId },
      include: { store: true, vehicleItems: true },
    });
    if (!model) throw new NotFoundException('Dòng xe không tồn tại');
    await this.assertStoreOwnership(partnerId, model.storeId);
    return model;
  }

  async updateModel(partnerId: number, modelId: number, dto: UpdateVehicleModelDto) {
    const model = await this.prisma.vehicleModel.findUnique({ where: { id: modelId } });
    if (!model) throw new NotFoundException('Dòng xe không tồn tại');
    await this.assertStoreOwnership(partnerId, model.storeId);
    if (dto.pricingTiers !== undefined) {
      this.validatePricingTiers(dto.pricingTiers);
    }

    return this.prisma.vehicleModel.update({
      where: { id: modelId },
      data: {
        ...dto,
        images: dto.images !== undefined ? dto.images : undefined,
        pricingTiers: dto.pricingTiers !== undefined ? (dto.pricingTiers as any) : undefined,
      },
    });
  }

  async deleteModel(partnerId: number, modelId: number) {
    const model = await this.prisma.vehicleModel.findUnique({
      where: { id: modelId },
      include: {
        vehicleItems: true,
        bookingDetails: {
          include: { booking: true },
        },
      },
    });
    if (!model) throw new NotFoundException('Dòng xe không tồn tại');
    await this.assertStoreOwnership(partnerId, model.storeId);

    // Kiểm tra xem có đơn thuê đang hoạt động với dòng xe này không
    const activeBookingDetail = model.bookingDetails?.find((bd) =>
      [0, 1, 2, 4].includes(bd.booking?.status),
    );
    if (activeBookingDetail) {
      throw new BadRequestException('Không thể xóa dòng xe đang có đơn thuê đang hoạt động hoặc chờ nhận xe!');
    }

    return this.prisma.$transaction(async (tx) => {
      // 1. Xóa các booking detail lịch sử liên quan đến dòng xe này
      await tx.bookingDetail.deleteMany({ where: { modelId } });

      // 2. Xóa các xe / biển số thuộc dòng xe này
      await tx.vehicleItem.deleteMany({ where: { modelId } });

      // 3. Xóa dòng xe
      return tx.vehicleModel.delete({ where: { id: modelId } });
    });
  }

  // ─── PARTNER: VehicleItem CRUD ───────────────────────────────────────────────

  async addVehicleItem(partnerId: number, modelId: number, dto: CreateVehicleItemDto) {
    const model = await this.prisma.vehicleModel.findUnique({ where: { id: modelId } });
    if (!model) throw new NotFoundException('Dòng xe không tồn tại');
    await this.assertStoreOwnership(partnerId, model.storeId);

    const existing = await this.prisma.vehicleItem.findUnique({
      where: { licensePlate: dto.licensePlate },
    });
    if (existing) throw new ConflictException('Biển số xe đã tồn tại trong hệ thống');

    return this.prisma.vehicleItem.create({
      data: { modelId, ...dto },
    });
  }

  async addBulkVehicleItems(partnerId: number, modelId: number, items: CreateVehicleItemDto[]) {
    const model = await this.prisma.vehicleModel.findUnique({ where: { id: modelId } });
    if (!model) throw new NotFoundException('Dòng xe không tồn tại');
    await this.assertStoreOwnership(partnerId, model.storeId);

    const createdItems: any[] = [];
    const duplicates: string[] = [];

    for (const item of items) {
      if (!item.licensePlate || !item.licensePlate.trim()) continue;
      const plate = item.licensePlate.trim().toUpperCase();

      const existing = await this.prisma.vehicleItem.findUnique({
        where: { licensePlate: plate },
      });
      if (existing) {
        duplicates.push(plate);
        continue;
      }

      const created = await this.prisma.vehicleItem.create({
        data: {
          modelId,
          licensePlate: plate,
          color: item.color ? item.color.trim() : 'Tiêu chuẩn',
          chassisNumber: item.chassisNumber ? item.chassisNumber.trim() : null,
          status: 0,
        },
      });
      createdItems.push(created);
    }

    return {
      success: true,
      totalAdded: createdItems.length,
      items: createdItems,
      duplicates,
      message:
        `Đã thêm thành công ${createdItems.length} xe vào kho.` +
        (duplicates.length > 0 ? ` Bỏ qua ${duplicates.length} biển số bị trùng: ${duplicates.join(', ')}` : ''),
    };
  }

  async getVehicleItems(partnerId: number, modelId: number) {
    const model = await this.prisma.vehicleModel.findUnique({ where: { id: modelId } });
    if (!model) throw new NotFoundException('Dòng xe không tồn tại');
    await this.assertStoreOwnership(partnerId, model.storeId);

    return this.prisma.vehicleItem.findMany({ where: { modelId } });
  }

  async updateVehicleItem(
    partnerId: number,
    itemId: number,
    dto: UpdateVehicleItemDto,
  ) {
    const item = await this.prisma.vehicleItem.findUnique({
      where: { id: itemId },
      include: { model: true },
    });
    if (!item) throw new NotFoundException('Xe không tồn tại');
    await this.assertStoreOwnership(partnerId, item.model.storeId);

    if (dto.licensePlate && dto.licensePlate.trim() !== item.licensePlate) {
      const existing = await this.prisma.vehicleItem.findUnique({
        where: { licensePlate: dto.licensePlate.trim() },
      });
      if (existing) {
        throw new ConflictException(`Biển số xe ${dto.licensePlate} đã tồn tại trong hệ thống!`);
      }
    }

    if (dto.status !== undefined && dto.status !== item.status) {
      if (item.status === 1 || item.status === 2) {
        const text = item.status === 2 ? 'đang cho thuê' : 'đang được giữ chỗ cho khách';
        throw new BadRequestException(
          `Xe này hiện ${text}, không thể thay đổi trạng thái thủ công! Vui lòng thao tác qua đơn thuê (bàn giao / trả xe).`
        );
      }
      if (dto.status === 1 || dto.status === 2) {
        throw new BadRequestException(
          'Không thể chuyển xe sang trạng thái "Đang giữ" hoặc "Đang cho thuê" thủ công. Trạng thái này được cập nhật tự động khi có đơn thuê.'
        );
      }
    }

    return this.prisma.vehicleItem.update({
      where: { id: itemId },
      data: {
        licensePlate: dto.licensePlate !== undefined ? dto.licensePlate.trim() : undefined,
        color: dto.color !== undefined ? dto.color.trim() : undefined,
        chassisNumber: dto.chassisNumber !== undefined ? dto.chassisNumber.trim() : undefined,
        status: dto.status !== undefined ? dto.status : undefined,
      },
    });
  }

  async updateVehicleItemStatus(
    partnerId: number,
    itemId: number,
    dto: UpdateVehicleItemStatusDto,
  ) {
    const item = await this.prisma.vehicleItem.findUnique({
      where: { id: itemId },
      include: {
        model: true,
        bookingDetails: {
          where: { booking: { status: { in: [0, 1, 2, 3] } } },
          include: { booking: true },
        },
      },
    });
    if (!item) throw new NotFoundException('Xe không tồn tại');
    await this.assertStoreOwnership(partnerId, item.model.storeId);

    // Validate: Không cho phép đổi trạng thái thủ công nếu xe đang bận / có đơn
    const isBusy = item.status === 1 || item.status === 2 || (item.bookingDetails && item.bookingDetails.length > 0);
    if (isBusy) {
      const text = item.status === 2 ? 'đang cho thuê' : 'đang được giữ chỗ cho khách';
      throw new BadRequestException(
        `Xe này hiện ${text}, không thể thay đổi trạng thái thủ công! Vui lòng thao tác qua đơn thuê (bàn giao / trả xe).`
      );
    }

    // Không cho phép tự ý chuyển sang Đang giữ hoặc Đang thuê mà không qua đơn
    if (dto.status === 1 || dto.status === 2) {
      throw new BadRequestException(
        'Không thể chuyển xe sang trạng thái "Đang giữ" hoặc "Đang cho thuê" thủ công. Trạng thái này được cập nhật tự động khi có đơn thuê.'
      );
    }

    return this.prisma.vehicleItem.update({
      where: { id: itemId },
      data: { status: dto.status },
    });
  }

  async deleteVehicleItem(partnerId: number, itemId: number) {
    const item = await this.prisma.vehicleItem.findUnique({
      where: { id: itemId },
      include: {
        model: true,
        bookingDetails: {
          include: { booking: true },
        },
      },
    });
    if (!item) throw new NotFoundException('Xe không tồn tại');
    await this.assertStoreOwnership(partnerId, item.model.storeId);

    // Kiểm tra xem xe có đang trong đơn thuê hoạt động không
    const activeBookingDetail = item.bookingDetails?.find((bd) =>
      [0, 1, 2, 4].includes(bd.booking?.status),
    );
    if (activeBookingDetail) {
      throw new BadRequestException('Không thể xóa xe đang trong đơn thuê hoạt động hoặc chờ nhận xe!');
    }

    // Set null cho past booking details để không vi phạm ràng buộc khóa ngoại
    await this.prisma.bookingDetail.updateMany({
      where: { vehicleItemId: itemId },
      data: { vehicleItemId: null },
    });

    return this.prisma.vehicleItem.delete({ where: { id: itemId } });
  }

  // ─── PUBLIC: Search VehicleModels with availability (Flow 1) ────────────────

  async searchPublic(dto: SearchVehiclesDto) {
    const { startTime, endTime, type, brand, storeId, province, page = 1, limit = 10 } = dto;
    const skip = (page - 1) * limit;

    const where: Prisma.VehicleModelWhereInput = {
      store: {
        status: 1, // 1 = ACTIVE
        partner: { status: true }, // Đối tác phải đang hoạt động (không bị khóa)
        ...(province && province.trim() && province !== 'all' && {
          OR: [
            { province: { contains: province.trim() } },
            { province: { contains: province.replace(/^TP\.\s*/i, '').trim() } },
            { address: { contains: province.trim() } },
            { address: { contains: province.replace(/^TP\.\s*/i, '').trim() } },
          ],
        }),
      },
      ...(type !== undefined && { type }),
      ...(brand && { brand: { contains: brand } }),
      ...(storeId && { storeId }),
    };

    const hasClientCoords = typeof dto.lat === 'number' && !isNaN(dto.lat) && typeof dto.lng === 'number' && !isNaN(dto.lng);

    let models: any[];
    let total: number;

    const storeSelect = {
      id: true,
      storeName: true,
      address: true,
      latitude: true,
      longitude: true,
      phoneContact: true,
      province: true,
      reputationScore: true,
    };

    if (hasClientCoords) {
      const allMatchingModels = await this.prisma.vehicleModel.findMany({
        where,
        include: {
          store: { select: storeSelect },
          vehicleItems: {
            select: { id: true, status: true },
          },
        },
      });

      total = allMatchingModels.length;

      allMatchingModels.sort((a, b) => {
        const distA =
          a.store?.latitude != null && a.store?.longitude != null
            ? calculateHaversineDistance(dto.lat!, dto.lng!, a.store.latitude, a.store.longitude)
            : null;
        const distB =
          b.store?.latitude != null && b.store?.longitude != null
            ? calculateHaversineDistance(dto.lat!, dto.lng!, b.store.latitude, b.store.longitude)
            : null;

        if (distA !== null && distB !== null) {
          return distA - distB;
        }
        if (distA !== null) return -1;
        if (distB !== null) return 1;
        return (b.store?.reputationScore ?? 0) - (a.store?.reputationScore ?? 0);
      });

      models = allMatchingModels.slice(skip, skip + limit);
    } else {
      total = await this.prisma.vehicleModel.count({ where });
      models = await this.prisma.vehicleModel.findMany({
        where,
        include: {
          store: { select: storeSelect },
          vehicleItems: {
            select: { id: true, status: true },
          },
        },
        orderBy: [
          { store: { reputationScore: 'desc' } },
          { id: 'desc' },
        ],
        skip,
        take: limit,
      });
    }

    const requestStart = new Date(startTime);
    const requestEnd = new Date(endTime);

    // For each model, apply Flow 1 availability formula
    const result = await Promise.all(
      models.map(async (model) => {
        // TotalActiveVehicleItems = xe không bị bảo dưỡng (status != 3)
        const totalActiveItems = model.vehicleItems.filter((vi: any) => vi.status !== 3).length;

        // BusyVehicleCount: tính tổng số lượng xe bận trùng khoảng thời gian (hỗ trợ đơn đặt nhiều xe)
        const busyAgg = await this.prisma.bookingDetail.aggregate({
          where: {
            modelId: model.id,
            booking: {
              AND: [
                {
                  OR: [
                    { status: { in: [1, 3] } },
                    {
                      status: 0,
                      holdExpiresAt: { gt: new Date() },
                    },
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
        const availableCount = Math.max(0, totalActiveItems - busyCount);

        // Thống kê đánh giá thực tế của dòng xe
        const reviewsAgg = await this.prisma.review.aggregate({
          where: {
            isHidden: false,
            booking: { bookingDetails: { some: { modelId: model.id } } },
          },
          _avg: { rateStar: true },
          _count: { id: true },
        });

        const reviewCount = reviewsAgg._count.id;
        const avgRating =
          reviewCount > 0 && reviewsAgg._avg.rateStar
            ? Number(reviewsAgg._avg.rateStar.toFixed(1))
            : 5.0;

        // Thống kê đánh giá trung bình của cửa hàng
        const storeReviewsAgg = await this.prisma.review.aggregate({
          where: {
            isHidden: false,
            storeId: model.storeId,
          },
          _avg: { rateStar: true },
          _count: { id: true },
        });
        const storeReviewCount = storeReviewsAgg._count.id;
        const storeAvgRating =
          storeReviewCount > 0 && storeReviewsAgg._avg.rateStar
            ? Number(storeReviewsAgg._avg.rateStar.toFixed(1))
            : 5.0;

        let distanceKm: number | null = null;
        if (hasClientCoords && model.store?.latitude != null && model.store?.longitude != null) {
          distanceKm = calculateHaversineDistance(dto.lat!, dto.lng!, model.store.latitude, model.store.longitude);
        }

        const { vehicleItems: _, ...modelData } = model;
        return {
          ...modelData,
          store: {
            ...model.store,
            avgRating: storeAvgRating,
            reviewCount: storeReviewCount,
            distanceKm,
          },
          distanceKm,
          totalActiveItems,
          busyCount,
          availableCount,
          avgRating,
          reviewCount,
        };
      }),
    );

    return {
      data: result,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async getModelDetail(modelId: number, startTime: string, endTime: string) {
    const model = await this.prisma.vehicleModel.findFirst({
      where: {
        id: modelId,
        store: {
          status: 1, // ACTIVE
          partner: { status: true }, // Partner không bị khóa
        },
      },
      include: {
        store: {
          include: { rentalPolicy: true },
        },
        vehicleItems: { select: { id: true, status: true, color: true } },
      },
    });
    if (!model) throw new NotFoundException('Dòng xe không tồn tại hoặc đối tác đã ngưng hoạt động');

    const requestStart = new Date(startTime);
    const requestEnd = new Date(endTime);

    const totalActiveItems = model.vehicleItems.filter((vi) => vi.status !== 3).length;

    const busyAgg = await this.prisma.bookingDetail.aggregate({
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
    const availableCount = Math.max(0, totalActiveItems - busyCount);

    // Lấy danh sách đánh giá thực tế của dòng xe này
    const reviews = await this.prisma.review.findMany({
      where: {
        isHidden: false,
        booking: {
          bookingDetails: {
            some: { modelId },
          },
        },
      },
      include: {
        customer: { select: { fullName: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    const reviewCount = reviews.length;
    const avgRating =
      reviewCount > 0
        ? Number((reviews.reduce((acc, r) => acc + r.rateStar, 0) / reviewCount).toFixed(1))
        : 5.0;

    const storeReviews = await this.prisma.review.findMany({
      where: { storeId: model.storeId, isHidden: false },
      select: { rateStar: true },
    });
    const storeReviewCount = storeReviews.length;
    const storeAvgRating =
      storeReviewCount > 0
        ? Number((storeReviews.reduce((acc, r) => acc + r.rateStar, 0) / storeReviewCount).toFixed(1))
        : 5.0;

    const { vehicleItems: _, ...modelData } = model;
    return {
      ...modelData,
      store: {
        ...model.store,
        avgRating: storeAvgRating,
        reviewCount: storeReviewCount,
      },
      totalActiveItems,
      busyCount,
      availableCount,
      reviews,
      avgRating,
      reviewCount,
    };
  }

  // ─── Helper ──────────────────────────────────────────────────────────────────

  private async assertStoreOwnership(partnerId: number, storeId: number) {
    const store = await this.prisma.store.findFirst({ where: { id: storeId, partnerId } });
    if (!store) throw new ForbiddenException('Bạn không có quyền thao tác cửa hàng này');
    return store;
  }
}
