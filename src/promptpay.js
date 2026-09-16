/*
 * PromptPay — สร้าง payload มาตรฐาน EMVCo สำหรับ QR รับเงิน
 *
 * ทำไมมีไฟล์นี้: โจทย์บอกว่า "quote ที่เลย expires_at … ห้ามออก QR" และ
 * "quote ที่ยังเป็น draft ห้ามออก QR" — การจะห้ามได้ ต้องมีของให้ห้ามจริง ๆ
 * ตรงนี้คือตัวสร้าง payload ส่วนด่านอนุญาตอยู่ที่ canIssueQr() ใน src/quotes.js
 *
 * ไฟล์นี้ทำหน้าที่เดียว: ประกอบ "สตริง payload" ให้ถูกตามมาตรฐาน
 * ส่วนการแปลงเป็นภาพอยู่ที่ src/qr-encode.js (ตารางโมดูล) กับ src/qr-png.js (ไฟล์ PNG)
 * ทั้งสองตัวเขียนเองโดยไม่พึ่งไลบรารีนอก — ดูเหตุผลใน src/qr-encode.js
 *
 * อ้างอิงรูปแบบ: EMVCo Merchant Presented QR + ข้อกำหนดพร้อมเพย์ของ ธปท.
 */

const tag = (id, value) => `${id}${String(value.length).padStart(2, "0")}${value}`;

/* เบอร์ไทยในพร้อมเพย์เขียนเป็น 13 หลัก: 0066 + เบอร์ที่ตัด 0 หน้าออก */
export function toPromptPayTarget(phone) {
  const digits = String(phone ?? "").replace(/\D/g, "");
  if (digits.length < 9) return null;
  const national = digits.startsWith("66") ? digits.slice(2) : digits.replace(/^0/, "");
  if (national.length !== 9) return null;
  return `0066${national}`.padStart(13, "0");
}

/*
 * CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) — มาตรฐานบังคับของ EMVCo
 * คิดรวมตัว "6304" ที่เป็นหัวของช่อง CRC เองด้วย แล้วต่อค่า 4 หลักท้ายสุด
 */
export function crc16(input) {
  let crc = 0xffff;
  for (const byte of Buffer.from(input, "utf8")) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

/*
 * คืนสตริง payload หรือ null ถ้าข้อมูลไม่ครบ
 * ยอดต้องเป็นตัวเลขบวกเสมอ — QR ที่ไม่มียอดคือ QR รับเงินแบบปลายเปิด
 * ซึ่งไม่ควรออกจากใบเสนอราคาที่มียอดชัดอยู่แล้ว
 */
export function promptPayPayload({ phone, amount }) {
  const target = toPromptPayTarget(phone);
  const value = Number(amount);
  if (!target || !Number.isFinite(value) || value <= 0) return null;

  const merchant = tag("00", "A000000677010111") + tag("01", target);
  const body =
    tag("00", "01") +
    tag("01", "12") + // 12 = ใช้ครั้งเดียว (ผูกกับยอดของใบนี้) ไม่ใช่ QR ถาวรของร้าน
    tag("29", merchant) +
    tag("53", "764") + // THB
    tag("54", value.toFixed(2)) +
    tag("58", "TH");

  const withCrcTag = `${body}6304`;
  return withCrcTag + crc16(withCrcTag);
}
