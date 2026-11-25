import { Body, Controller, HttpCode, Logger, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../../prisma/prisma.service';
import { escapeHtml, sendTelegramMessage } from '../../common/utils/mail.util';

@ApiTags('Webhooks - Telegram')
@Controller('webhooks/telegram')
export class TelegramController {
  private readonly logger = new Logger(TelegramController.name);

  constructor(private readonly prisma: PrismaService) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Webhook công khai nhận sự kiện từ Telegram Bot (/start store_<storeId>)',
  })
  async handleTelegramWebhook(@Body() body: any) {
    try {
      const message = body?.message;
      const chatId = message?.chat?.id;
      const text: string = (message?.text || '').trim();

      if (!message || !chatId) {
        return { ok: true };
      }

      this.logger.log(
        `📩 [TelegramWebhook] Nhận tin nhắn từ chatId=${chatId}: "${text}"`,
      );

      // Khớp lệnh /start store_<storeId> hoặc /start@BotName store_<storeId>
      const match = text.match(/^\/start(?:@\S+)?\s+store_(\d+)/i);
      if (match) {
        const storeId = Number(match[1]);
        const store = await this.prisma.store.findUnique({
          where: { id: storeId },
        });

        if (!store) {
          this.logger.warn(
            `⚠️ [TelegramWebhook] Không tìm thấy Store #${storeId} cho chatId=${chatId}`,
          );
          await sendTelegramMessage(
            String(chatId),
            `❌ Không tìm thấy cửa hàng mã #${storeId} trên hệ thống VehicleRent. Vui lòng kiểm tra lại liên kết trong trang quản lý cửa hàng.`,
          );
          return { ok: true };
        }

        await this.prisma.store.update({
          where: { id: storeId },
          data: { telegramChatId: String(chatId) },
        });

        this.logger.log(
          `✅ [TelegramWebhook] Đã kết nối Store #${store.id} (${store.storeName}) với telegramChatId=${chatId}`,
        );

        await sendTelegramMessage(
          String(chatId),
          `Đã kết nối thông báo đơn hàng thành công cho cửa hàng ${escapeHtml(store.storeName)}!`,
        );
        return { ok: true };
      }

      if (text.startsWith('/start')) {
        await sendTelegramMessage(
          String(chatId),
          `Xin chào! Để kết nối thông báo đơn đặt xe tự động cho cửa hàng của bạn, vui lòng bấm nút "Kết nối Telegram nhận thông báo đơn" trong mục Cài đặt chi nhánh trên VehicleRent.\n\nChat ID của bạn là: <code>${chatId}</code>`,
        );
      }

      return { ok: true };
    } catch (err: any) {
      this.logger.error(
        `❌ [TelegramWebhook] Lỗi xử lý webhook: ${err?.message || err}`,
      );
      return { ok: true };
    }
  }
}
