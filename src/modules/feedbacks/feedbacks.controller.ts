import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { FeedbacksService } from './feedbacks.service';
import { CreateFeedbackDto } from './dto/create-feedback.dto';
import { UpdateFeedbackStatusDto } from './dto/update-feedback-status.dto';
import { JwtAuthGuard, OptionalJwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../auth/roles.decorator';
import { Throttle } from '@nestjs/throttler';

@ApiTags('Feedbacks (Customer)')
@Controller('feedbacks')
export class FeedbacksController {
  constructor(private readonly feedbacksService: FeedbacksService) {}

  @Get('my-feedbacks')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Lấy danh sách phản hồi / góp ý của khách hàng hiện tại' })
  findMyFeedbacks(@Req() req: any) {
    const userId = req.user.id;
    const email = req.user.email;
    return this.feedbacksService.findMyFeedbacks(userId, email);
  }

  @Post()
  @UseGuards(OptionalJwtAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({ summary: 'Gửi ý kiến đóng góp / phản hồi của khách hàng (Public & User)' })
  @ApiResponse({ status: 201, description: 'Gửi ý kiến đóng góp thành công' })
  create(@Body() dto: CreateFeedbackDto, @Req() req: any) {
    // SECURITY: Use verified JWT user id if authenticated, never trust body user_id
    const authUserId = req.user?.id ? Number(req.user.id) : null;
    return this.feedbacksService.create(dto, authUserId);
  }
}

@ApiTags('Admin - Feedbacks')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(0) // 0: Admin
@Controller('admin/feedbacks')
export class AdminFeedbacksController {
  constructor(private readonly feedbacksService: FeedbacksService) {}

  @Get()
  @ApiOperation({ summary: 'Lấy toàn bộ danh sách ý kiến đóng góp của khách hàng (Admin)' })
  @ApiQuery({ name: 'status', required: false, type: Number, description: '0: Mới, 1: Đang xử lý, 2: Đã giải quyết' })
  @ApiQuery({ name: 'category', required: false, type: String })
  @ApiQuery({ name: 'search', required: false, type: String })
  findAll(
    @Query('status') status?: string,
    @Query('category') category?: string,
    @Query('search') search?: string,
  ) {
    const statusNum = status !== undefined && status !== '' ? parseInt(status, 10) : undefined;
    return this.feedbacksService.findAllAdmin({
      status: statusNum,
      category,
      search,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Xem chi tiết một ý kiến đóng góp' })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.feedbacksService.findOne(id);
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Cập nhật trạng thái xử lý và ghi chú phản hồi của Admin' })
  updateStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateFeedbackStatusDto,
  ) {
    return this.feedbacksService.updateStatus(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Xóa ý kiến đóng góp' })
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.feedbacksService.remove(id);
  }
}

