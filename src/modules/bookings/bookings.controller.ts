import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { BookingsService } from './bookings.service';
import { CreateBookingDto } from './dto/create-booking.dto';
import { CancelBookingDto } from './dto/cancel-booking.dto';
import { CreateWalkInBookingDto } from './dto/create-walkin-booking.dto';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RolesGuard } from '../../auth/roles.guard';
import { Roles } from '../../auth/roles.decorator';
import { Throttle } from '@nestjs/throttler';

// ─── CUSTOMER BOOKING ROUTES ─────────────────────────────────────────────────

@ApiTags('Customer - Bookings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(2) // Customer only
@Controller('customer/bookings')
export class CustomerBookingsController {
  constructor(private readonly bookingsService: BookingsService) {}

  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @Post()
  @ApiOperation({
    summary: 'Tạo đơn đặt xe & giữ chỗ 10 phút (Flow 2)',
    description: `
**Quy trình xử lý (Flow 2):**
1. Kiểm tra xe khả dụng theo [startTime, endTime] theo công thức Flow 1.
2. Tính dayRent = CEIL(giờ / 24), rentAmount, depositAmount, commissionAmount.
3. Tạo Booking (status=0, holdExpiresAt=NOW+10min) + BookingDetail + Payment (Pending).
4. Trả về transactionRef để Customer thanh toán VietQR.
    `,
  })
  @ApiResponse({ status: 201, description: 'Đặt xe & giữ chỗ thành công, trả về transactionRef' })
  @ApiResponse({ status: 400, description: 'XE_KHONG_KHA_DUNG hoặc dữ liệu không hợp lệ' })
  @ApiResponse({ status: 401, description: 'Chưa đăng nhập' })
  @ApiResponse({ status: 403, description: 'Chỉ Customer mới được đặt xe' })
  createBooking(@Request() req: any, @Body() dto: CreateBookingDto) {
    return this.bookingsService.create(req.user.id, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Lấy danh sách đơn thuê của Customer (lịch sử đặt xe)' })
  getMyBookings(@Request() req: any) {
    return this.bookingsService.findMyBookings(req.user.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Xem chi tiết 1 đơn thuê của Customer' })
  @ApiResponse({ status: 403, description: 'Không có quyền xem đơn của người khác' })
  getBookingDetail(@Request() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.bookingsService.findOne(req.user.id, id);
  }

  @Post(':id/cancel')
  @ApiOperation({ summary: 'Hủy đơn thuê xe (hỗ trợ cả đơn Pending 0 và đơn Confirmed 1 có yêu cầu hoàn cọc)' })
  cancelBooking(
    @Request() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto?: CancelBookingDto,
  ) {
    return this.bookingsService.cancelBooking(req.user.id, id, dto);
  }

  @Post(':id/review')
  @ApiOperation({ summary: 'Gửi đánh giá trải nghiệm cho đơn thuê đã hoàn thành' })
  createReview(
    @Request() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: { rateStar: number; comment?: string },
  ) {
    return this.bookingsService.createReview(req.user.id, id, dto);
  }

  @Post(':id/report-issue')
  @ApiOperation({ summary: 'Khách hàng báo sự cố: Nhà xe không có xe khi sát/tới giờ nhận' })
  reportIssue(
    @Request() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: { reason: string; bankName?: string; bankAccountNumber?: string; bankAccountName?: string },
  ) {
    return this.bookingsService.reportIssueByCustomer(req.user.id, id, dto);
  }
}

// ─── PARTNER BOOKING ROUTES ───────────────────────────────────────────────────

@ApiTags('Partner - Bookings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(1) // Partner only
@Controller('partner/bookings')
export class PartnerBookingsController {
  constructor(private readonly bookingsService: BookingsService) {}

  @Get()
  @ApiOperation({ summary: 'Xem danh sách đơn thuê thuộc stores của Partner' })
  @ApiQuery({ name: 'status', required: false, type: Number, description: '0-5, bỏ trống để lấy tất cả' })
  @ApiQuery({ name: 'storeId', required: false, type: Number, description: 'Lọc theo ID chi nhánh' })
  getPartnerBookings(
    @Request() req: any,
    @Query('status') status?: string,
    @Query('storeId') storeId?: string,
  ) {
    const statusNum = status !== undefined && status !== '' ? parseInt(status, 10) : undefined;
    const storeIdNum = storeId !== undefined && storeId !== '' ? parseInt(storeId, 10) : undefined;
    return this.bookingsService.findPartnerBookings(req.user.id, statusNum, storeIdNum);
  }

  @Post('walk-in')
  @ApiOperation({
    summary: 'Tạo đơn thuê trực tiếp tại quầy cho khách vãng lai',
    description: 'Dành cho nhân viên cửa hàng tạo đơn nhanh khi khách đến thuê trực tiếp, đồng nhất số lượng xe.',
  })
  @ApiResponse({ status: 201, description: 'Tạo đơn thành công' })
  @ApiResponse({ status: 400, description: 'Xe không khả dụng hoặc dữ liệu không hợp lệ' })
  createWalkInBooking(@Request() req: any, @Body() dto: CreateWalkInBookingDto) {
    return this.bookingsService.createWalkInBooking(req.user.id, dto);
  }

  @Post(':id/handover')
  @ApiOperation({
    summary: 'Bàn giao xe (Flow 6a) — chọn biển số xe để giao cho khách',
    description: 'Đơn phải ở trạng thái **Confirmed (1)**. Chuyển xe sang Rented, đơn sang ActiveRental.',
  })
  @ApiResponse({ status: 400, description: 'Đơn không ở trạng thái Confirmed hoặc xe không Available' })
  handover(
    @Request() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: any,
  ) {
    let ids: number[] = [];
    if (body?.vehicleItemIds && Array.isArray(body.vehicleItemIds) && body.vehicleItemIds.length > 0) {
      ids = body.vehicleItemIds.map((x: any) => Number(x)).filter((n: number) => !isNaN(n));
    } else if (body?.vehicleItemId) {
      const single = Number(body.vehicleItemId);
      if (!isNaN(single)) ids = [single];
    }
    return this.bookingsService.handoverVehicle(req.user.id, id, ids);
  }

  @Post(':id/complete')
  @ApiOperation({
    summary: 'Xác nhận khách trả xe (Flow 6b) — hoàn tất đơn thuê',
    description: 'Đơn phải ở trạng thái **ActiveRental (3)**. Xe trở về Available, đơn sang Completed.',
  })
  @ApiResponse({ status: 400, description: 'Đơn không ở trạng thái ActiveRental' })
  complete(@Request() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.bookingsService.completeBooking(req.user.id, id);
  }

  @Post(':id/no-show')
  @ApiOperation({ summary: 'Cửa hàng báo khách không đến (No-show) sau giờ hẹn — Giải phóng xe, giữ cọc, không trừ uy tín' })
  noShow(@Request() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.bookingsService.noShowByStore(req.user.id, id);
  }

  @Post(':id/cancel-by-store')
  @ApiOperation({ summary: 'Cửa hàng tự hủy do hết xe — Hoàn 100% cọc + bồi thường 20% (min 50k), trừ điểm uy tín' })
  cancelByStore(
    @Request() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: { reason: string; isForceMajeure?: boolean; forceMajeureProof?: string },
  ) {
    return this.bookingsService.cancelByStore(req.user.id, id, dto);
  }

  @Post(':id/id-card')
  @ApiOperation({ summary: 'Lưu ảnh CCCD 2 mặt lúc bàn giao xe (Chuẩn Nghị định 13/2023/NĐ-CP)' })
  saveIdCard(
    @Request() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: { idCardFront: string; idCardBack: string },
  ) {
    return this.bookingsService.saveIdCard(req.user.id, id, dto);
  }

  @Get(':id/id-card')
  @ApiOperation({ summary: 'Xem ảnh CCCD bàn giao xe (Chỉ chủ cửa hàng đơn đó và Admin)' })
  getIdCard(@Request() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.bookingsService.getIdCard(req.user.id, req.user.role, id);
  }
}

// ─── ADMIN REVIEW MODERATION ROUTES ──────────────────────────────────────────

@ApiTags('Admin - Reviews')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(0) // Admin only
@Controller('admin/reviews')
export class AdminReviewsController {
  constructor(private readonly bookingsService: BookingsService) {}

  @Get()
  @ApiOperation({ summary: 'Lấy toàn bộ đánh giá của khách hàng trên hệ thống' })
  findAll() {
    return this.bookingsService.findAllReviews();
  }

  @Post(':id/hide')
  @ApiOperation({ summary: 'Ẩn đánh giá vi phạm tiêu chuẩn cộng đồng' })
  hide(@Param('id', ParseIntPipe) id: number, @Body('hiddenReason') hiddenReason: string) {
    return this.bookingsService.hideReview(id, hiddenReason || 'Vi phạm tiêu chuẩn cộng đồng');
  }

  @Post(':id/unhide')
  @ApiOperation({ summary: 'Bỏ ẩn đánh giá' })
  unhide(@Param('id', ParseIntPipe) id: number) {
    return this.bookingsService.unhideReview(id);
  }
}

// ─── ADMIN STATS & BOOKINGS ROUTES ──────────────────────────────────────────

@ApiTags('Admin - Statistics & Bookings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(0) // Admin only
@Controller('admin')
export class AdminStatsController {
  constructor(private readonly bookingsService: BookingsService) {}

  @Get('stats')
  @ApiOperation({ summary: 'Lấy toàn bộ số liệu thống kê thực tế sàn (Doanh thu, hoa hồng, trạng thái đơn, đội xe)' })
  getPlatformStats() {
    return this.bookingsService.getPlatformStats();
  }

  @Get('bookings')
  @ApiOperation({ summary: 'Lấy tất cả đơn thuê trên toàn hệ thống sàn' })
  getAllBookings() {
    return this.bookingsService.findAllBookingsForAdmin();
  }

  @Post('bookings/:id/resolve-dispute')
  @ApiOperation({ summary: 'Admin đối soát tranh chấp đơn thuê giữa khách và nhà xe' })
  resolveDispute(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: { isStoreFault: boolean; note?: string },
  ) {
    return this.bookingsService.adminResolveDispute(id, dto);
  }

  @Get('bookings/:id/id-card')
  @ApiOperation({ summary: 'Admin xem ảnh CCCD bàn giao xe (Chuẩn Nghị định 13)' })
  getAdminIdCard(@Request() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.bookingsService.getIdCard(req.user.id, req.user.role, id);
  }
}


