/*
 * ยามแจ้งด่วน — กวาด event queue ทุก 2 นาที แล้วแจ้งเจ้าของร้านเรื่องที่รอไม่ได้
 *
 * ═══ ทำไมไม่ยิงทันทีตอนเกิดเหตุอย่างเดียว ═══
 * ยิงทันทีอย่างเดียวแปลว่า ถ้าจังหวะนั้นส่งไม่ผ่าน (LINE ล่ม / ยังไม่มีแอดมิน / process ตาย)
 * เรื่องนั้นหายไปเลยโดยไม่มีใครรู้ว่าเคยมี
 *
 * ที่นี่จึงทำสองชั้น: ยิงทันทีเมื่อมี event ใหม่ (เพื่อให้เร็ว) + กวาดซ้ำทุก 2 นาที (เพื่อให้ครบ)
 * แล้วกัน "แจ้งซ้ำ" ด้วย dedupe key ต่อ event ต่อ trigger — ไม่ว่าจะถูกกวาดกี่รอบ
 * เคสเดิมก็ถูกแจ้งครั้งเดียว
 *
 * ═══ ไม่ใช้ AI จำเอง ═══
 * เกณฑ์ทั้งหมดเป็นรหัส trigger ที่ต้นทางติดมากับ event ตอนบันทึก (src/customer-events.js)
 * ยามตัวนี้แค่อ่านไฟล์แล้วเทียบรายการ — ผลลัพธ์จึงเหมือนเดิมทุกครั้งที่รัน
 */

import fs from "node:fs";
import path from "node:path";

import { bangkokDate, bangkokTime, eventsDir } from "./customer-events.js";

const FILE_MODE = 0o600;

/* ทุก 2 นาทีตามโจทย์ */
export const TICK_MS = 2 * 60 * 1000;

/*
 * เหตุแจ้งด่วนทั้งหมด — เพิ่ม/ลดได้ที่นี่ที่เดียว
 * next คือ "สิ่งที่เจ้าของต้องทำต่อ" ซึ่งต้องมีทุกอันเสมอ
 * การแจ้งเตือนที่ไม่บอกว่าให้ทำอะไรต่อ คือการปลุกคนขึ้นมาดูแล้วให้ไปคิดเอง
 */
export const TRIGGERS = {
  over_discount: { label: "ต่อรองเกินเพดาน", icon: "🏷", next: "ตัดสินใจว่าจะอนุมัติส่วนลดให้หรือไม่" },
  high_value: { label: "ยอดเกิน 50,000 บาท", icon: "💰", next: "ตรวจใบเสนอราคาแล้วอนุมัติหรือปฏิเสธ" },
  ask_owner: { label: "ลูกค้าขอคุยกับเจ้าของ", icon: "🙋", next: "เข้าไปคุยกับลูกค้าในห้องนี้เอง" },
  complaint: { label: "ร้องเรียน", icon: "⚠️", next: "อ่านเรื่องแล้วตอบลูกค้าด้วยตัวเอง" },
  slip_in: { label: "สลิปเข้า", icon: "💸", next: "เช็กยอดในแอปธนาคารแล้วพิมพ์ ยืนยันยอด <quote_id>" },
  new_appointment: { label: "นัดใหม่", icon: "📅", next: "ยืนยันวันเวลากับลูกค้าแล้วลงตารางร้าน" },
  delivery_appointment: { label: "ลูกค้านัดขนส่ง", icon: "🚚", next: "เช็กคิวรถแล้วยืนยันรอบส่งกับลูกค้า" },
  pickup_request: { label: "ลูกค้าขอมารับที่ร้าน", icon: "🏪", next: "ยืนยันเวลาที่ลูกค้าจะมารับและเตรียมของ" },
};

export const isTrigger = (id) => Object.hasOwn(TRIGGERS, String(id));

export function createUrgentGuard({
  events,
  reports,
  dir = eventsDir(),
  now = () => new Date(),
  log = console,
} = {}) {
  /* ที่เก็บว่าอะไรถูกแจ้งไปแล้ว — อยู่ข้าง ๆ ไฟล์ event เพราะเป็นข้อมูลชุดเดียวกัน */
  const sentFile = path.join(dir, "urgent-sent.json");

  const readSent = () => {
    try {
      return JSON.parse(fs.readFileSync(sentFile, "utf8"));
    } catch {
      return {};
    }
  };

  const writeSent = (sent) => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, `.urgent-sent.${process.pid}.tmp`);
    fs.writeFileSync(tmp, `${JSON.stringify(sent, null, 2)}\n`, { mode: FILE_MODE });
    fs.chmodSync(tmp, FILE_MODE);
    fs.renameSync(tmp, sentFile);
  };

  /* หนึ่ง event อาจติดหลาย trigger — คีย์จึงต้องแยกต่อ trigger ไม่ใช่ต่อ event */
  const keyOf = (event, trigger) => `${event.id}:${trigger}`;

  const compose = (event, trigger) => {
    const t = TRIGGERS[trigger];
    return [
      `${t.icon} ${t.label}`,
      `${String(event.at).slice(11, 16)} น. · ห้อง …${event.suffix}`,
      event.handoff ? `เรื่อง: ${event.handoff}` : null,
      `ต้องทำต่อ: ${event.next_step ?? t.next}`,
    ]
      .filter(Boolean)
      .join("\n");
  };

  return {
    TICK_MS,
    sentFile,

    /* คีย์ที่ถูกแจ้งไปแล้ว พร้อมเวลาและผลส่ง — ใช้ตอนตรวจสอบย้อนหลัง */
    sentLog: readSent,

    /*
     * กวาด 1 รอบ — คืน { checked, sent, skipped }
     * กวาดทั้งวันนี้และเมื่อวาน เผื่อเหตุที่เกิดใกล้เที่ยงคืนแล้วส่งไม่ผ่าน
     * (ไฟล์ event แยกตามวันไทย ถ้ากวาดแต่วันนี้ เหตุเมื่อ 23:59 จะไม่มีใครกลับไปดูอีกเลย)
     */
    async tick() {
      const today = bangkokDate(now());
      const yesterday = bangkokDate(new Date(now().getTime() - 24 * 60 * 60 * 1000));
      const rows = [...events.readDay(yesterday), ...events.readDay(today)];

      const sent = readSent();
      let delivered = 0;
      let skipped = 0;
      let checked = 0;
      let dirty = false;

      for (const event of rows) {
        for (const trigger of event.triggers ?? []) {
          if (!isTrigger(trigger)) continue;
          checked++;

          const key = keyOf(event, trigger);

          /*
           * เคยส่งเข้าตัวส่งรายงานไปแล้ว = จบ ไม่ส่งซ้ำ
           *
           * จงใจไม่เช็คว่า "ถึงมือแอดมินแล้วหรือยัง" เพราะตอนยังไม่มีใคร claim
           * ของจะถูกเก็บเข้าคิวไว้ (deliver=local) ซึ่งตัวส่งรายงานรับประกันว่าจะเทให้ครบตอน claim
           * ถ้ายึดเอา "ถึงมือแล้ว" เป็นเกณฑ์ รอบกวาดถัดไปจะเห็นว่ายังไม่ถึงแล้วส่งซ้ำ
           * เจ้าของร้านจะได้เรื่องเดิมสองครั้งทันทีที่ claim เสร็จ
           */
          if (sent[key]) {
            skipped++;
            continue;
          }

          const result = await reports.submit("urgent", compose(event, trigger));
          sent[key] = { sent_at: bangkokTime(now()), date: today, result: result === "admin" ? "sent" : "queued" };
          dirty = true;
          if (result === "admin") delivered++;
        }
      }

      /*
       * เก็บเฉพาะคีย์ของ 2 วันล่าสุด — ไฟล์นี้โตเรื่อย ๆ ถ้าไม่ตัด
       * และคีย์ของ event ที่ถูกกวาดทิ้งตาม retention ไปแล้วก็ไม่มีประโยชน์อะไรอีก
       */
      if (dirty) {
        const alive = new Set(rows.map((e) => e.id));
        for (const key of Object.keys(sent)) {
          if (!alive.has(key.split(":")[0])) delete sent[key];
        }
        writeSent(sent);
      }

      if (delivered > 0) log.log?.(`🔔 ยามแจ้งด่วนส่ง ${delivered} เรื่องให้เจ้าของร้าน`);
      return { checked, sent: delivered, skipped };
    },
  };
}
