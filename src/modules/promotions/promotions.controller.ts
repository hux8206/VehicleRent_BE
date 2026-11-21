import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PromotionsService } from './promotions.service';
import { CreatePromotionDto } from './dto/create-promotion.dto';
import { ValidatePromotionDto } from './dto/validate-promotion.dto';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../auth/roles.decorator';
import { Throttle } from '@nestjs/throttler';

@ApiTags('Promotions & Discounts')
@Controller('promotions')
export class PublicPromotionsController {
  constructor(private readonly promotionsService: PromotionsService) {}

  @Get('active')
  @ApiOperation({ summary: 'Lấy danh sách mã khuyến mãi đang hoạt động (Public)' })
  getActivePromotions() {
    return this.promotionsService.findActivePublic();
  }

  @Post('validate')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @ApiOperation({ summary: 'Kiểm tra tính hợp lệ và tính mức giảm giá của mã' })
  validatePromotion(@Body() dto: ValidatePromotionDto) {
    return this.promotionsService.validate(dto);
  }
}

@ApiTags('Admin - Promotions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(0) // 0: Admin
@Controller('admin/promotions')
export class AdminPromotionsController {
  constructor(private readonly promotionsService: PromotionsService) {}

  @Get()
  @ApiOperation({ summary: 'Danh sách toàn bộ chương trình khuyến mãi (Admin)' })
  getAllPromotions() {
    return this.promotionsService.findAllAdmin();
  }

  @Post()
  @ApiOperation({ summary: 'Tạo mã khuyến mãi mới (Admin)' })
  createPromotion(@Body() dto: CreatePromotionDto) {
    return this.promotionsService.create(dto);
  }

  @Patch(':id/toggle')
  @ApiOperation({ summary: 'Bật / Tắt trạng thái kích hoạt mã (Admin)' })
  togglePromotion(@Param('id', ParseIntPipe) id: number) {
    return this.promotionsService.toggleActive(id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Xóa chương trình khuyến mãi (Admin)' })
  deletePromotion(@Param('id', ParseIntPipe) id: number) {
    return this.promotionsService.delete(id);
  }
}

