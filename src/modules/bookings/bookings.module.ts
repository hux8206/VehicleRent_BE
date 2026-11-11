import { Module } from '@nestjs/common';
import {
  CustomerBookingsController,
  PartnerBookingsController,
  AdminReviewsController,
  AdminStatsController,
} from './bookings.controller';
import { BookingsService } from './bookings.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { PaymentsModule } from '../payments/payments.module';

@Module({
  imports: [PrismaModule, PaymentsModule],
  controllers: [
    CustomerBookingsController,
    PartnerBookingsController,
    AdminReviewsController,
    AdminStatsController,
  ],
  providers: [BookingsService],
  exports: [BookingsService],
})
export class BookingsModule {}

