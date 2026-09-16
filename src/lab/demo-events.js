/*
 * ชุดข้อมูลทดลอง — pseudonymous ล้วน รูปร่างตาม schema customer-events
 *
 * ═══ ทำไมต้องสร้างเอง ไม่ดึงของจริง ═══
 * โจทย์สั่งว่า "ห้ามดึงข้อมูลจริงอัตโนมัติ" ซึ่งไม่ใช่แค่เรื่อง PDPA
 * แต่เป็นเรื่องของการพิสูจน์ด้วย: ถ้า Lab ทำงานกับข้อมูลที่เราไม่รู้คำตอบล่วงหน้า
 * เราจะไม่มีทางรู้เลยว่ามันสรุปถูกหรือสรุปมั่ว
 *
 * ชุดนี้จึงถูกปั้นให้ "รู้คำตอบอยู่แล้ว": มีกลุ่มพนักงานออฟฟิศแทรกอยู่จริง
 * ในจำนวนที่ตั้งใจ — ถ้า Lab หาไม่เจอหรือหาเจอผิดจำนวน แปลว่า Lab พัง ไม่ใช่ข้อมูลแปลก
 *
 * ═══ สุ่มแบบเดิมทุกครั้ง ═══
 * ใช้ seed คงที่ ข้อมูลชุดเดียวกันจึงออกมาเหมือนเดิมเป๊ะทุกครั้งที่รัน
 * รายงานที่เปลี่ยนไปมาทั้งที่ข้อมูลเท่าเดิม คือรายงานที่เชื่อไม่ได้
 */

import { bangkokStamp } from "../customer-events.js";

/* mulberry32 — PRNG สั้น ๆ ที่ให้ผลเหมือนเดิมทุกครั้งเมื่อ seed เท่ากัน */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (r, list) => list[Math.floor(r() * list.length)];

/*
 * แบบแผนของลูกค้าแต่ละกลุ่ม — ตัวกำหนดว่า event จะหน้าตาแบบไหน
 * weight คือสัดส่วนที่จะโผล่ในข้อมูล
 */
const SHAPES = {
  /* ① นักเรียน — เย็น ๆ ของชิ้นเล็ก ถามราคาบ่อย ต่อราคา */
  student: {
    weight: 0.42,
    hours: [15, 16, 17],
    products: ["brownie-piece", "shio-pan"],
    intents: ["ask_price", "ask_photo", "greeting", "ask_quote"],
    triggers: [[], [], [], ["over_discount"]],
  },
  /* ② คุณแม่มารับลูก — เย็น เป็นกล่อง ตัดสินใจเร็ว */
  parent_pickup: {
    weight: 0.33,
    hours: [16, 17, 18],
    products: ["brownie-box", "box-set-1"],
    intents: ["ask_quote", "confirm_order", "ask_price", "ask_photo"],
    triggers: [[], [], ["pickup_request"]],
  },
  /*
   * ③ พนักงานออฟฟิศ — กลุ่มที่ "ยังไม่ใช่ Persona"
   * สั่งเป็นเซ็ตใหญ่ไปเลี้ยงที่ออฟฟิศ ถามตอนพักเที่ยง และนัดขนส่ง
   * ตั้งใจใส่ไว้ให้ Lab หาเจอเป็น emerging
   */
  office: {
    weight: 0.2,
    hours: [11, 12, 13, 20],
    products: ["box-set-1", "brownie-box"],
    intents: ["ask_quote", "ask_delivery", "ask_price"],
    triggers: [["delivery_appointment"], ["pickup_request"], [], ["high_value"]],
  },
  /* ④ เคสเดี่ยว ๆ ที่ไม่ซ้ำใคร — ตั้งใจให้เป็น outlier */
  event_organizer: {
    weight: 0.05,
    hours: [10, 14],
    products: ["box-set-1"],
    intents: ["ask_quote"],
    triggers: [["high_value"], ["ask_owner"]],
  },
};

const UNANSWERED = [
  "มีสาขาอื่นไหมคะ",
  "รับทำเป็นของชำร่วยงานแต่งไหม",
  "มีสูตรไม่มีน้ำตาลไหมคะ",
  "ส่งต่างจังหวัดได้ไหม",
  "มีใบกำกับภาษีไหมคะ",
];

const HANDOFFS = ["ส่วนลดเกินเพดาน", "ยอดเกินเกณฑ์", "ลูกค้าขอคุยกับเจ้าของ"];

/*
 * สร้าง event ย้อนหลัง N วัน — คืนอาร์เรย์เรียงตามเวลา
 *
 * suffix ถูกสุ่มจากชุดตัวอักษร/ตัวเลข 4 ตัว ไม่ได้มาจาก id จริงของใคร
 * และไม่มีฟิลด์ไหนเก็บข้อความที่ลูกค้าพิมพ์จริง มีแต่ "คำถามที่ตอบไม่ได้"
 * ซึ่งเป็นประโยคที่เขียนไว้ล่วงหน้าในไฟล์นี้ ไม่ใช่ของใครทั้งนั้น
 */
export function generateDemoEvents({ days = 90, perDay = 6, seed = 20260916, endDate = new Date() } = {}) {
  const r = rng(seed);
  const shapes = Object.entries(SHAPES);
  const events = [];

  /* ห้องลูกค้าสมมติ — สุ่มไว้ล่วงหน้าเพื่อให้ห้องเดิมกลับมาซ้ำได้เหมือนลูกค้าจริง */
  const rooms = Object.fromEntries(
    shapes.map(([name]) => [name, Array.from({ length: 14 }, () => Math.floor(r() * 0xffff).toString(16).padStart(4, "0"))]),
  );

  for (let d = days - 1; d >= 0; d--) {
    /*
     * กลุ่มออฟฟิศเพิ่งเริ่มโตใน 30 วันหลัง — ทำให้ weekly comparison มีอะไรให้เทียบจริง
     * ถ้ากระจายเท่ากันทั้ง 90 วัน การเทียบสัปดาห์จะไม่ต่างกันเลยและพิสูจน์อะไรไม่ได้
     */
    const officeBoost = d < 30 ? 2.2 : 0.35;
    const count = Math.max(1, Math.round(perDay * (0.6 + r() * 0.8)));

    for (let i = 0; i < count; i++) {
      const weighted = shapes.flatMap(([name, s]) => {
        const w = Math.round((name === "office" ? s.weight * officeBoost : s.weight) * 100);
        return Array.from({ length: w }, () => name);
      });
      const shapeName = pick(r, weighted);
      const shape = SHAPES[shapeName];

      const at = new Date(endDate.getTime() - d * 86400_000);
      at.setUTCHours(pick(r, shape.hours) - 7, Math.floor(r() * 60), Math.floor(r() * 60), 0);

      const intent = pick(r, shape.intents);
      const triggers = pick(r, shape.triggers);
      const hasHandoff = triggers.length > 0 && r() < 0.7;

      events.push({
        id: `demo-${d}-${i}`,
        at: bangkokStamp(at),
        suffix: pick(r, rooms[shapeName]),
        intent,
        lead: intent === "ask_quote" || intent === "confirm_order" ? "hot" : intent === "greeting" ? "cold" : "warm",
        handoff: hasHandoff ? pick(r, HANDOFFS) : null,
        unanswered: r() < 0.08 ? pick(r, UNANSWERED) : null,
        next_step: hasHandoff ? "ตัดสินใจแล้วแจ้งลูกค้ากลับ" : null,
        triggers,
        product: r() < 0.85 ? pick(r, shape.products) : null,
      });
    }
  }

  return events.sort((a, b) => a.at.localeCompare(b.at));
}
