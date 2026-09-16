/*
 * บันทึกเหตุขัดข้องสำหรับเจ้าของร้าน
 *
 * ═══ ทำไมต้องมีแยกจาก log ปกติ ═══
 * log ของเซิร์ฟเวอร์เขียนไว้ให้คนเขียนโค้ดอ่าน มี stack trace และศัพท์เทคนิคเต็มไปหมด
 * เจ้าของร้านต้องการรู้แค่ 5 อย่าง: เกิดตอนไหน · ห้องไหน · พังเรื่องอะไร ·
 * ลองใหม่แล้วได้ไหม · สุดท้ายลูกค้าได้อะไรไป · แล้วต้องทำอะไรต่อ
 *
 * ═══ ไม่มี Secret ไม่มี PII เกินจำเป็น ═══
 * เก็บ suffix 4 ตัวของห้องเท่านั้น ไม่เก็บ LINE user id เต็ม ไม่เก็บข้อความลูกค้า
 * ไม่เก็บ token ไม่เก็บ URL และไม่เก็บ error object ดิบ (ซึ่งมัก มี header กับ URL ติดมา)
 */

import fs from "node:fs";
import path from "node:path";

import { bangkokDate, bangkokStamp, eventsDir, suffixOf } from "./customer-events.js";

const FILE_MODE = 0o600;

export const RETENTION_DAYS = 30;

/* หมวดความพังที่รู้จัก — ตรงกับ fault 5 แบบที่ต้องทดสอบ */
export const FAILURE_CLASSES = {
  line_api: { label: "ส่งข้อความผ่าน LINE ไม่ได้", next: "เช็กสถานะ LINE Messaging API และโควตาข้อความรายเดือน" },
  model: { label: "สมองร้านตอบไม่ได้", next: "เช็ก OPENROUTER_API_KEY และเครดิตคงเหลือ" },
  timeout: { label: "รอคำตอบนานเกินกำหนด", next: "ดูว่าปลายทางช้าผิดปกติหรือเน็ตของ VPS มีปัญหา" },
  reply_token: { label: "ตอบกลับไม่ทันเวลาของ LINE", next: "ดูว่าลูกค้ารอนานผิดปกติไหม อาจต้องลดเวลารอพิมพ์จบ" },
  brain: { label: "อ่านไฟล์สมองร้านไม่ได้", next: "เช็กว่า context.md / products.md / promotions.md ยังอยู่ครบ" },
  unknown: { label: "ขัดข้องที่ยังไม่รู้สาเหตุ", next: "ดู log ของเซิร์ฟเวอร์ช่วงเวลานั้น" },
};

export const classOf = (id) => (Object.hasOwn(FAILURE_CLASSES, id) ? id : "unknown");

export const incidentsDir = () => path.join(eventsDir(), "..", "incidents");

export function createIncidentLog({ dir = incidentsDir(), now = () => new Date(), log = console } = {}) {
  const ensure = () => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    return dir;
  };
  const fileOf = (date) => path.join(dir, `${date}.jsonl`);

  return {
    dir,
    ensure,

    /*
     * บันทึก 1 เหตุ — คืน record ที่เขียนลงไป
     * retry / fallback รับเป็นคำสั้น ๆ ที่เราตั้งเอง ไม่ใช่ข้อความจาก error
     */
    record({ chatId, failure = "unknown", retry = "ไม่ได้ลองใหม่", fallback = "ไม่มี", detail = null } = {}) {
      ensure();
      const at = now();
      const cls = classOf(failure);
      const record = {
        at: bangkokStamp(at),
        suffix: suffixOf(chatId),
        failure: cls,
        failure_label: FAILURE_CLASSES[cls].label,
        retry,
        fallback,
        next_action: FAILURE_CLASSES[cls].next,
        /* detail ต้องเป็นคำอธิบายสั้น ๆ ที่เราเขียนเอง ไม่ใช่ error.message ดิบ */
        detail: detail ? String(detail).slice(0, 120) : null,
      };

      const file = fileOf(bangkokDate(at));
      fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: FILE_MODE });
      try {
        fs.chmodSync(file, FILE_MODE);
      } catch {
        /* ไฟล์เพิ่งถูกกวาดทิ้ง */
      }
      log.warn?.(`🩹 ${record.failure_label} (ห้อง …${record.suffix}) · ลองใหม่: ${retry} · ลูกค้าได้: ${fallback}`);
      return record;
    },

    readDay(date = bangkokDate(now())) {
      try {
        return fs.readFileSync(fileOf(date), "utf8").split("\n").filter(Boolean).map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        }).filter(Boolean);
      } catch {
        return [];
      }
    },

    days() {
      try {
        return fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).map((n) => n.slice(0, 10)).sort();
      } catch {
        return [];
      }
    },

    sweep({ days = RETENTION_DAYS } = {}) {
      const cutoff = bangkokDate(new Date(now().getTime() - days * 24 * 60 * 60 * 1000));
      let removed = 0;
      for (const date of this.days()) {
        if (date >= cutoff) continue;
        try {
          fs.unlinkSync(fileOf(date));
          removed++;
        } catch {
          /* หายไปแล้ว */
        }
      }
      return removed;
    },
  };
}
