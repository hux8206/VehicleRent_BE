import { Module } from '@nestjs/common';
import { PromotionsService } from './promotions.service';
import {
  AdminPromotionsController,
  PublicPromotionsController,
} from './promotions.controller';

@Module({
  controllers: [PublicPromotionsController, AdminPromotionsController],
  providers: [PromotionsService],
  exports: [PromotionsService],
})
export class PromotionsModule {}

