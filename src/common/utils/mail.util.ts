import { Logger } from '@nestjs/common';
import { Resend } from 'resend';

const logger = new Logger('NotificationUtil');

export interface NewBookingNotificationPayload {
  toEmail: string;
  telegramChatId?: string | null;
  partnerName?: string | null;
  storeName: string;
  bookingCode: string;
  vehicleName: string;
  quantity: number;
  startTime: Date;
  endTime: Date;
  dayRent: number;
  customerName: string;
  customerPhone: string;
  depositAmount: number;
  rentAmount: number;
  sourceLabel?: string;
  pickupType?: number;
  deliveryAddress?: string | null;
}

export function escapeHtml(value: string | number | null | undefined): string {
  const str = String(value ?? '');
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatVnDateTime(date: Date): string {
  try {
    return new Intl.DateTimeFormat('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

/**
 * Gửi tin nhắn qua Telegram Bot API (sendMessage).
 * Đọc token từ process.env.TELEGRAM_BOT_TOKEN.
 */
export async function sendTelegramMessage(
  chatId: string,
  text: string,
): Promise<boolean> {
  const cleanChatId = chatId?.trim();
  if (!cleanChatId) return false;

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    logger.warn(
      `⚠️ [Telegram] Chưa cấu hình TELEGRAM_BOT_TOKEN. Bỏ qua gửi tin nhắn tới chatId=${cleanChatId}.`,
    );
    return false;
  }

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: cleanChatId,
          text,
          parse_mode: 'HTML',
        }),
      },
    );

    const data: any = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) {
      logger.error(
        `❌ [Telegram] Gửi tin nhắn tới chatId=${cleanChatId} thất bại (HTTP ${res.status}): ${JSON.stringify(data)}`,
      );
      return false;
    }

    logger.log(
      `📲 [Telegram] Đã gửi tin nhắn thành công tới chatId=${cleanChatId} (message_id=${data?.result?.message_id})`,
    );
    return true;
  } catch (err: any) {
    logger.error(
      `❌ [Telegram] Lỗi ngoại lệ khi gửi tin nhắn tới chatId=${cleanChatId}: ${err?.message || err}`,
    );
    return false;
  }
}

/**
 * Gửi thông báo đơn đặt xe mới qua Telegram tới chi nhánh (nếu đã kết nối telegramChatId).
 */
export async function sendPartnerNewBookingTelegram(
  payload: NewBookingNotificationPayload,
): Promise<void> {
  const chatId = payload.telegramChatId?.trim();
  if (!chatId) {
    return;
  }

  const startStr = formatVnDateTime(new Date(payload.startTime));
  const endStr = formatVnDateTime(new Date(payload.endTime));
  const depositStr = `${Math.round(payload.depositAmount).toLocaleString('vi-VN')} VNĐ`;
  const rentStr = `${Math.round(payload.rentAmount).toLocaleString('vi-VN')} VNĐ`;

  const lines = [
    `🔔 <b>ĐƠN ĐẶT XE MỚI ĐÃ XÁC NHẬN</b>`,
    `🏪 Cửa hàng: <b>${escapeHtml(payload.storeName)}</b>`,
    payload.sourceLabel ? `📌 Hình thức: <i>${escapeHtml(payload.sourceLabel)}</i>` : '',
    ``,
    `🆔 Mã đơn: <code>${escapeHtml(payload.bookingCode)}</code>`,
    `🛵 Dòng xe: <b>${escapeHtml(payload.vehicleName)}</b>`,
    `🔢 Số lượng: <b>${escapeHtml(payload.quantity)} xe</b> (${escapeHtml(payload.dayRent)} ngày)`,
    `📅 Nhận xe: <b>${escapeHtml(startStr)}</b>`,
    `🏁 Trả xe: <b>${escapeHtml(endStr)}</b>`,
    `👤 Khách hàng: <b>${escapeHtml(payload.customerName)}</b>`,
    `📞 SĐT: <b>${escapeHtml(payload.customerPhone || 'Chưa cập nhật')}</b>`,
    payload.pickupType === 1 && payload.deliveryAddress
      ? `📍 Giao tận nơi: ${escapeHtml(payload.deliveryAddress)}`
      : '',
    `💰 Tiền cọc / đã thu: <b>${escapeHtml(depositStr)}</b> (Tổng thuê: ${escapeHtml(rentStr)})`,
  ].filter((line) => line !== undefined);

  logger.log(
    `📤 [Telegram] Đang gửi thông báo đơn ${payload.bookingCode} tới Store "${payload.storeName}" (chatId=${chatId})...`,
  );
  await sendTelegramMessage(chatId, lines.join('\n'));
}

/**
 * Gửi email thông báo đơn đặt xe mới đã xác nhận tới Partner/Cửa hàng thông qua Resend HTTP API.
 * Đọc key từ RESEND_API_KEY || MAIL_PASS, from từ MAIL_FROM.
 * Luôn log chi tiết kết quả ra console (Logger) và bắt mọi lỗi để không làm gián đoạn luồng tạo đơn/webhook.
 */
export async function sendPartnerNewBookingEmail(
  payload: NewBookingNotificationPayload,
): Promise<void> {
  const email = payload.toEmail?.trim();
  if (!email || email.endsWith('@vehiclerent.local')) {
    logger.warn(
      `⚠️ [Resend] Không có email hợp lệ của cửa hàng/đối tác cho đơn ${payload.bookingCode} (${email || 'trống'}). Bỏ qua gửi email.`,
    );
    return;
  }

  const resendApiKey = process.env.RESEND_API_KEY || process.env.MAIL_PASS;
  const mailFrom = process.env.MAIL_FROM || 'VehicleRent <noreply@thuexetulai.io.vn>';

  if (!resendApiKey) {
    logger.warn(
      `⚠️ [Resend] Chưa cấu hình RESEND_API_KEY hoặc MAIL_PASS. Bỏ qua gửi email thông báo đơn mới ${payload.bookingCode} tới ${email}.`,
    );
    return;
  }

  const startStr = formatVnDateTime(new Date(payload.startTime));
  const endStr = formatVnDateTime(new Date(payload.endTime));
  const depositStr = `${Math.round(payload.depositAmount).toLocaleString('vi-VN')} VNĐ`;
  const rentStr = `${Math.round(payload.rentAmount).toLocaleString('vi-VN')} VNĐ`;
  const remainingStr = `${Math.max(0, Math.round(payload.rentAmount - payload.depositAmount)).toLocaleString('vi-VN')} VNĐ`;

  const subject = `[VehicleRent] Đơn đặt xe mới #${payload.bookingCode} - ${payload.vehicleName}`;

  const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 14px; background-color: #ffffff;">
  <div style="text-align: center; margin-bottom: 20px;">
    <h2 style="color: #2563eb; margin: 0; font-size: 24px; font-weight: 800; letter-spacing: -0.5px;">VehicleRent</h2>
    <p style="color: #64748b; font-size: 13px; margin: 4px 0 0;">Thông báo đơn đặt xe mới đã xác nhận</p>
  </div>

  <div style="border-top: 1px solid #f1f5f9; padding-top: 20px;">
    <p style="color: #1e293b; font-size: 15px; margin: 0 0 12px;">
      Xin chào <strong>${escapeHtml(payload.partnerName || payload.storeName)}</strong>,
    </p>
    <p style="color: #475569; font-size: 14px; line-height: 1.6; margin: 0 0 18px;">
      Cửa hàng <strong>${escapeHtml(payload.storeName)}</strong> vừa nhận được một đơn thuê xe mới đã xác nhận${payload.sourceLabel ? ` (${escapeHtml(payload.sourceLabel)})` : ''}. Chi tiết đơn hàng:
    </p>

    <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 16px; margin-bottom: 20px;">
      <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
        <tr>
          <td style="padding: 6px 0; color: #64748b; width: 40%;">Mã đơn hàng:</td>
          <td style="padding: 6px 0; color: #1e40af; font-weight: 800; font-family: monospace;">${escapeHtml(payload.bookingCode)}</td>
        </tr>
        <tr>
          <td style="padding: 6px 0; color: #64748b;">Tên xe:</td>
          <td style="padding: 6px 0; color: #0f172a; font-weight: 700;">${escapeHtml(payload.vehicleName)}</td>
        </tr>
        <tr>
          <td style="padding: 6px 0; color: #64748b;">Số lượng:</td>
          <td style="padding: 6px 0; color: #0f172a; font-weight: 700;">${escapeHtml(payload.quantity)} xe (${escapeHtml(payload.dayRent)} ngày)</td>
        </tr>
        <tr>
          <td style="padding: 6px 0; color: #64748b;">Thời gian nhận xe:</td>
          <td style="padding: 6px 0; color: #0f172a; font-weight: 600;">${escapeHtml(startStr)}</td>
        </tr>
        <tr>
          <td style="padding: 6px 0; color: #64748b;">Thời gian trả xe:</td>
          <td style="padding: 6px 0; color: #0f172a; font-weight: 600;">${escapeHtml(endStr)}</td>
        </tr>
        <tr>
          <td style="padding: 6px 0; color: #64748b;">Khách hàng:</td>
          <td style="padding: 6px 0; color: #0f172a; font-weight: 700;">${escapeHtml(payload.customerName)}</td>
        </tr>
        <tr>
          <td style="padding: 6px 0; color: #64748b;">SĐT khách hàng:</td>
          <td style="padding: 6px 0; color: #0f172a; font-weight: 700;">${escapeHtml(payload.customerPhone || 'Chưa cập nhật')}</td>
        </tr>
        ${
          payload.pickupType === 1 && payload.deliveryAddress
            ? `<tr>
          <td style="padding: 6px 0; color: #64748b;">Giao tận nơi:</td>
          <td style="padding: 6px 0; color: #0f172a; font-weight: 600;">${escapeHtml(payload.deliveryAddress)}</td>
        </tr>`
            : ''
        }
        <tr style="border-top: 1px dashed #cbd5e1;">
          <td style="padding: 10px 0 4px; color: #64748b;">Tổng tiền thuê:</td>
          <td style="padding: 10px 0 4px; color: #0f172a; font-weight: 700;">${escapeHtml(rentStr)}</td>
        </tr>
        <tr>
          <td style="padding: 4px 0; color: #64748b;">Tiền cọc / đã thu:</td>
          <td style="padding: 4px 0; color: #059669; font-weight: 800;">${escapeHtml(depositStr)}</td>
        </tr>
        <tr>
          <td style="padding: 4px 0; color: #64748b;">Còn thu khi nhận xe:</td>
          <td style="padding: 4px 0; color: #d97706; font-weight: 800;">${escapeHtml(remainingStr)}</td>
        </tr>
      </table>
    </div>

    <p style="color: #64748b; font-size: 13px; line-height: 1.5; margin: 0;">
      Vui lòng truy cập trang quản lý Đối tác trên VehicleRent để kiểm tra lịch xe, chuẩn bị xe và bàn giao đúng giờ cho khách hàng.
    </p>
  </div>
</div>
  `;

  const text = [
    `Xin chào ${payload.partnerName || payload.storeName},`,
    ``,
    `Cửa hàng ${payload.storeName} vừa nhận được đơn đặt xe mới đã xác nhận:`,
    `- Mã đơn: ${payload.bookingCode}`,
    `- Tên xe: ${payload.vehicleName}`,
    `- Số lượng: ${payload.quantity} xe (${payload.dayRent} ngày)`,
    `- Thời gian nhận xe: ${startStr}`,
    `- Thời gian trả xe: ${endStr}`,
    `- Khách hàng: ${payload.customerName} (${payload.customerPhone || 'Chưa cập nhật'})`,
    `- Tiền cọc / đã thu: ${depositStr} (Tổng tiền thuê: ${rentStr})`,
    ``,
    `Vui lòng đăng nhập cổng Đối tác VehicleRent để chuẩn bị xe bàn giao cho khách.`,
  ].join('\n');

  try {
    logger.log(
      `📤 [Resend] Đang gửi email thông báo đơn mới ${payload.bookingCode} tới ${email}...`,
    );
    const resend = new Resend(resendApiKey);
    const { data, error } = await resend.emails.send({
      from: mailFrom,
      to: [email],
      subject,
      html,
      text,
    });

    if (error) {
      logger.error(
        `❌ [Resend] Gửi email đơn mới ${payload.bookingCode} tới ${email} thất bại: ${JSON.stringify(error)}`,
      );
    } else {
      logger.log(
        `📧 [Resend] Đã gửi email thông báo đơn mới ${payload.bookingCode} thành công tới ${email}. Email ID: ${data?.id}`,
      );
    }
  } catch (err: any) {
    logger.error(
      `❌ [Resend] Lỗi ngoại lệ khi gửi email đơn mới ${payload.bookingCode} tới ${email}: ${err?.message || JSON.stringify(err)}`,
    );
  }
}

/**
 * Gửi thông báo đa kênh (Email qua Resend + Telegram Bot) cho chi nhánh cửa hàng khi có đơn mới xác nhận.
 */
export async function notifyPartnerNewBooking(
  payload: NewBookingNotificationPayload,
): Promise<void> {
  await Promise.allSettled([
    sendPartnerNewBookingEmail(payload),
    sendPartnerNewBookingTelegram(payload),
  ]);
}
