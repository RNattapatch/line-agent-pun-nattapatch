/*
 * ตัวเก็บเหตุการณ์ลูกค้า — ฐานข้อมูลเดียวที่ยามทั้งสองตัวอ่าน
 *
 * ═══ ทำไมต้องเขียนลงไฟล์ ไม่ให้ AI จำเอง ═══
 * รายงานเย็นกับแจ้งด่วนต้องตอบคำถามว่า "วันนี้เกิดอะไรขึ้นบ้าง" ให้ได้เหมือนเดิมทุกครั้ง
 * ถ้าให้โมเดลจำเอง คำตอบจะเปลี่ยนไปทุกรอบ และรีสตาร์ตทีเดียวก็ลืมทั้งวัน
 * ตัวเลขในรายงานที่เจ้าของร้านเอาไปตัดสินใจ ต้องนับจากของที่จับต้องได้เท่านั้น
 *
 * ═══ เก็บเท่าที่จำเป็น (PDPA) ═══
 * เก็บ: เวลาไทย · suffix 4 ตัวของห้อง · intent · เกรด lead · เหตุส่งต่อ · คำถามที่ตอบไม่ได้ · next step
 * ไม่เก็บ: LINE user id เต็ม · บทสนทนาดิบ · ชื่อ · เบอร์ · ที่อยู่ · เลขบัญชี
 *
 * ข้อยกเว้นเดียวคือ "คำถามที่ตอบไม่ได้" ซึ่งเป็นข้อความของลูกค้าตรง ๆ
 * เก็บเพราะโจทย์ต้องการหัวข้อนี้ในรายงาน (ไม่มีตัวคำถามก็ไม่มีอะไรให้เจ้าของร้านไปเติมคำตอบ)
 * แต่ตัดความยาวไว้ และเป็นฟิลด์เดียวที่มีข้อความลูกค้าอยู่ — ที่เหลือเป็นรหัสหมวดล้วน
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/* คำถามที่ตอบไม่ได้ เก็บยาวสุดกี่ตัวอักษร — ยาวกว่านี้ไม่ได้ช่วยให้เจ้าของร้านเข้าใจเพิ่ม */
const MAX_QUESTION = 160;

/* เก็บไฟล์ย้อนหลังกี่วัน */
export const RETENTION_DAYS = 30;

export const eventsDir = () =>
  process.env.SHOP_DATA_DIR
    ? path.join(process.env.SHOP_DATA_DIR, "customer-events")
    : path.join(os.homedir(), "shop-data", "customer-events");

/*
 * วันที่แบบไทย — ทั้งระบบต้องใช้ตัวนี้ตัวเดียว
 *
 * เซิร์ฟเวอร์ตั้งเป็น UTC (ปกติของ container) ถ้าใช้ getDate() ตรง ๆ
 * บทสนทนาตอนหนึ่งทุ่มของไทยจะถูกนับเป็น "เมื่อวาน" เพราะ UTC ยังไม่ขึ้นวันใหม่
 * แล้วรายงานเย็นจะรายงานวันผิดทั้งฉบับโดยไม่มีใครเอะใจ
 */
export const bangkokDate = (d = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(d);

/* เวลาไทยแบบ HH:MM — ใช้ในรายงานและข้อความแจ้งด่วน */
export const bangkokTime = (d = new Date()) =>
  new Intl.DateTimeFormat("th-TH", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit", hour12: false })
    .format(d);

/* เวลาไทยเต็มพร้อม offset — เก็บลงไฟล์ให้อ่านย้อนหลังได้โดยไม่ต้องเดา timezone */
export function bangkokStamp(d = new Date()) {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Bangkok",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).format(d);
  return `${parts.replace(" ", "T")}+07:00`;
}

/* หมวดของเหตุการณ์ — ใช้ทั้งนับ "คำถามยอดฮิต" และตั้งชื่อในรายงาน */
export const INTENTS = {
  greeting: "ทักทาย",
  ask_price: "ถามราคา",
  ask_photo: "ขอดูรูป/สินค้า",
  ask_quote: "ขอใบเสนอราคา",
  confirm_order: "ยืนยันสั่งซื้อ",
  ask_payment: "ถามช่องทางชำระเงิน",
  send_image: "ส่งรูปเข้ามา",
  ask_delivery: "ถามเรื่องจัดส่ง/นัดรับ",
  complaint: "ร้องเรียน",
  ask_owner: "ขอคุยกับเจ้าของ",
  other: "อื่น ๆ",
};

/* เกรด lead — เรียงจากร้อนไปเย็น */
export const LEAD_GRADES = ["hot", "warm", "cold"];

export const suffixOf = (id) => String(id ?? "").slice(-4) || "????";

export function createEventLog({ dir = eventsDir(), now = () => new Date() } = {}) {
  const ensure = () => {
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    fs.chmodSync(dir, DIR_MODE);
    return dir;
  };

  const fileOf = (date) => path.join(dir, `${date}.jsonl`);

  return {
    dir,
    ensure,

    /*
     * บันทึก 1 เหตุการณ์ — คืน record ที่เขียนลงไป
     *
     * append อย่างเดียว ไม่เคยแก้ของเดิม: ไฟล์รายวันจึงเป็นบันทึกที่ย้อนดูได้จริง
     * และการเขียนพร้อมกันจาก event หลายห้องไม่ชนกัน (append ของ O_APPEND เป็น atomic
     * สำหรับข้อมูลขนาดเล็กกว่า PIPE_BUF ซึ่งบรรทัด JSON แบบนี้ยาวไม่ถึง)
     */
    append({ chatId, intent = "other", lead = "cold", handoff = null, unanswered = null, nextStep = null, triggers = [] } = {}) {
      ensure();
      const at = now();
      const record = {
        id: `${at.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        at: bangkokStamp(at),
        suffix: suffixOf(chatId),
        intent: Object.hasOwn(INTENTS, intent) ? intent : "other",
        lead: LEAD_GRADES.includes(lead) ? lead : "cold",
        handoff: handoff ? String(handoff).slice(0, 200) : null,
        unanswered: unanswered ? String(unanswered).slice(0, MAX_QUESTION) : null,
        next_step: nextStep ? String(nextStep).slice(0, 200) : null,
        triggers: triggers.filter(Boolean),
      };

      const file = fileOf(bangkokDate(at));
      fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: FILE_MODE });
      try {
        fs.chmodSync(file, FILE_MODE);
      } catch {
        /* ไฟล์เพิ่งถูกกวาดทิ้งพอดี — รอบหน้าสร้างใหม่เอง */
      }
      return record;
    },

    /* อ่านเหตุการณ์ของวันหนึ่ง — [] ถ้าไม่มีไฟล์ (วันที่ไม่มีลูกค้าทักเข้ามาเลย) */
    readDay(date = bangkokDate(now())) {
      try {
        return fs
          .readFileSync(fileOf(date), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            try {
              return JSON.parse(line);
            } catch {
              /* บรรทัดพัง (เครื่องดับกลางเขียน) — ข้ามไป ดีกว่าทำให้รายงานทั้งฉบับล้ม */
              return null;
            }
          })
          .filter(Boolean);
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

    /* ลบไฟล์ที่เกิน retention — เรียกตอนบูตและตอนรายงานเย็นทำงาน */
    sweep({ days = RETENTION_DAYS } = {}) {
      const cutoff = bangkokDate(new Date(now().getTime() - days * 24 * 60 * 60 * 1000));
      let removed = 0;
      for (const date of this.days()) {
        if (date >= cutoff) continue;
        try {
          fs.unlinkSync(fileOf(date));
          removed++;
        } catch {
          /* หายไปแล้ว — ปลายทางที่ต้องการอยู่แล้ว */
        }
      }
      return removed;
    },
  };
}

export const customerEvents = createEventLog();
