import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateFeedbackDto } from './dto/create-feedback.dto';
import { UpdateFeedbackStatusDto } from './dto/update-feedback-status.dto';

@Injectable()
export class FeedbacksService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateFeedbackDto, authUserId?: number | null) {
    // SECURITY (Vibe-Check): Only associate feedback with a verified authenticated user ID
    const userId = authUserId || null;

    return this.prisma.feedback.create({
      data: {
        userId,
        fullName: dto.fullName.trim(),
        email: dto.email.trim().toLowerCase(),
        phone: dto.phone?.trim() || null,
        category: dto.category || 'GENERAL',
        rating: dto.rating ?? 5,
        subject: dto.subject.trim(),
        content: dto.content.trim(),
        status: 0, // Mới tiếp nhận
      },
    });
  }

  async findAllAdmin(query?: { status?: number; category?: string; search?: string }) {
    const where: any = {};

    if (query?.status !== undefined && !isNaN(query.status)) {
      where.status = Number(query.status);
    }

    if (query?.category && query.category !== 'ALL') {
      where.category = query.category;
    }

    if (query?.search && query.search.trim()) {
      const s = query.search.trim();
      where.OR = [
        { fullName: { contains: s } },
        { email: { contains: s } },
        { phone: { contains: s } },
        { subject: { contains: s } },
        { content: { contains: s } },
      ];
    }

    const feedbacks = await this.prisma.feedback.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        user: {
          select: {
            id: true,
            fullName: true,
            email: true,
            phone: true,
            role: true,
          },
        },
      },
    });

    const totalCount = await this.prisma.feedback.count();
    const pendingCount = await this.prisma.feedback.count({ where: { status: 0 } });
    const inProgressCount = await this.prisma.feedback.count({ where: { status: 1 } });
    const resolvedCount = await this.prisma.feedback.count({ where: { status: 2 } });
    const ratings = await this.prisma.feedback.aggregate({
      _avg: { rating: true },
    });

    return {
      feedbacks,
      stats: {
        total: totalCount,
        pending: pendingCount,
        inProgress: inProgressCount,
        resolved: resolvedCount,
        avgRating: ratings._avg.rating ? Number(ratings._avg.rating.toFixed(1)) : 5,
      },
    };
  }

  async findOne(id: number) {
    const feedback = await this.prisma.feedback.findUnique({
      where: { id },
      include: {
        user: {
          select: {
            id: true,
            fullName: true,
            email: true,
            phone: true,
          },
        },
      },
    });
    if (!feedback) {
      throw new NotFoundException(`Ý kiến đóng góp #${id} không tồn tại`);
    }
    return feedback;
  }

  async updateStatus(id: number, dto: UpdateFeedbackStatusDto) {
    await this.findOne(id);
    return this.prisma.feedback.update({
      where: { id },
      data: {
        status: dto.status,
        ...(dto.adminNote !== undefined && { adminNote: dto.adminNote }),
      },
    });
  }

  async findMyFeedbacks(userId: number, email?: string) {
    const conditions: any[] = [{ userId }];
    if (email && email.trim()) {
      conditions.push({ email: email.trim().toLowerCase() });
    }
    return this.prisma.feedback.findMany({
      where: {
        OR: conditions,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async remove(id: number) {
    await this.findOne(id);
    return this.prisma.feedback.delete({
      where: { id },
    });
  }
}

