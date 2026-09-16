/*
 * Admin lane — ช่องทางคำสั่งของเจ้าของร้าน
 *
 * หัวใจของไฟล์นี้คือ "คำสั่งเดียวกันต้องไม่มีผลถ้าพิมพ์มาจากห้องลูกค้า"
 * ถ้าไม่กันตรงนี้ ใครก็ตามที่เดาได้ว่า quote_id หน้าตาเป็น Q-YYYYMMDD-NNN
 * จะพิมพ์ "อนุมัติใบเสนอ Q-20260916-001" ในห้องตัวเองแล้วดันใบของตัวเองผ่านเพดานส่วนลดได้
 * ซึ่งเท่ากับเปิดให้ลูกค้าอนุมัติส่วนลดให้ตัวเอง
 *
 * เส้นแบ่งที่ใช้: ต้องเป็นแชท 1:1 กับ ADMIN_USER_ID (หรือกลุ่มที่ตั้งไว้ใน ADMIN_GROUP_ID)
 * แชทกลุ่มที่มีลูกค้าอยู่ด้วยไม่นับ ต่อให้เจ้าของร้านเป็นคนพิมพ์เอง
 * เพราะ event ในกลุ่มแยกไม่ออกว่าใครพิมพ์ ถ้า LINE ไม่ได้ส่ง userId มาให้ครบ
 *
 * ไม่ได้ตั้ง ADMIN_USER_ID ไว้ = ไม่มี admin lane เลย คำสั่งทุกคำสั่งไม่มีผล
 * (ปลอดภัยกว่าเดาว่าใครน่าจะเป็นแอดมิน)
 */

import { confirmPayment } from "./payment-flow.js";
import { reportLine } from "./quotes.js";

const QUOTE_ID = "(Q-\\d{8}-\\d{3})";

export const COMMANDS = [
  { name: "approve", re: new RegExp(`^อนุมัติใบเสนอ\\s+${QUOTE_ID}\\s*$`, "i") },
  { name: "reject", re: new RegExp(`^ปฏิเสธใบเสนอ\\s+${QUOTE_ID}\\s*$`, "i") },
  { name: "show", re: new RegExp(`^(?:ดูใบเสนอ|ใบเสนอ)\\s+${QUOTE_ID}\\s*$`, "i") },
  /*
   * ยืนยันว่าเงินเข้าบัญชีจริง — คำสั่งที่มีผลกับเงินมากที่สุดในไฟล์นี้
   * จงใจไม่รับรูปแบบย่อ ("ยืนยัน Q-…" / "ok Q-…") และไม่รับยอดต่อท้าย
   * ยอดที่ยืนยันคือยอดในใบ ไม่ใช่ยอดที่แอดมินพิมพ์ — พิมพ์ยอดมาด้วยได้เมื่อไหร่
   * วันหนึ่งจะมีคนพิมพ์ยอดที่ไม่ตรงกับใบแล้วระบบรับไว้เงียบ ๆ
   */
  { name: "confirm", re: new RegExp(`^ยืนยันยอด\\s+${QUOTE_ID}\\s*$`, "i") },
  { name: "today", re: /^ใบเสนอวันนี้\s*$/i },
];

/* ข้อความนี้หน้าตาเหมือนคำสั่งแอดมินไหม (ไม่สนว่าใครพิมพ์) */
export function parseCommand(input) {
  const text = String(input ?? "").trim();
  for (const { name, re } of COMMANDS) {
    const m = text.match(re);
    if (m) return { name, quoteId: m[1] ?? null };
  }
  return null;
}

/*
 * ห้องนี้เป็น admin lane ไหม
 * source.type ต้องเป็น "user" และ userId ต้องตรงกับ ADMIN_USER_ID เป๊ะ ๆ
 * (หรืออยู่ในกลุ่มแอดมินที่ตั้งไว้เอง)
 */
export function isAdminLane(event, { adminUserId, adminGroupId } = {}) {
  const src = event?.source;
  if (!src) return false;

  if (adminGroupId && (src.groupId === adminGroupId || src.roomId === adminGroupId)) return true;
  if (!adminUserId) return false;
  return src.type === "user" && src.userId === adminUserId;
}

/* ข้อความที่ตอบกลับคนที่พิมพ์คำสั่งแอดมินจากห้องลูกค้า
 * ปฏิเสธตรง ๆ ไม่รับปากว่าเดี๋ยวใครมาจัดการให้ — เหตุผลเดียวกับ src/guard.js */
export const NOT_ADMIN_REPLY =
  "ขออภัยค่ะ คำสั่งนี้ใช้ได้เฉพาะทีมงานของร้านนะคะ หากมีเรื่องสินค้า ราคา หรือการสั่งซื้อ ยินดีตอบให้เลยค่ะ";

const day = (d = new Date()) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;

/*
 * รันคำสั่ง — ผู้เรียกต้องเช็ค isAdminLane() มาแล้ว
 * คืน { reply } เสมอ (ข้อความที่ตอบกลับแอดมิน) และอาจมี quote ติดมาด้วย
 *
 * ทุกข้อความที่ตอบกลับใช้ reportLine() ซึ่งโชว์แค่ suffix 4 ตัว
 * LINE user id เต็มอยู่ในไฟล์บน VPS เท่านั้น
 */
export function runCommand(command, { store, approver = "admin" } = {}) {
  if (!command) return null;

  switch (command.name) {
    case "approve": {
      const res = store.approve(command.quoteId, approver);
      if (!res.ok) return { reply: `❌ ${command.quoteId}: ${res.error}` };
      return {
        quote: res.quote,
        reply: `✅ อนุมัติแล้ว\n${reportLine(res.quote)}\nส่งการ์ดใบเสนอราคาให้ลูกค้าได้เลยค่ะ`,
      };
    }

    case "reject": {
      const res = store.reject(command.quoteId, approver, "เจ้าของร้านปฏิเสธ");
      if (!res.ok) return { reply: `❌ ${command.quoteId}: ${res.error}` };
      /*
       * จงใจไม่ยิงข้อความหาลูกค้าเอง — ใบที่ถูกปฏิเสธมักมีเหตุผลที่ต้องอธิบายด้วยคน
       * ("ล็อตนี้ทำไม่ทัน" / "ลดให้ขนาดนั้นไม่ไหว") บอทตอบแทนแล้วมีแต่เสียลูกค้า
       */
      return {
        quote: res.quote,
        reply: `🚫 ปฏิเสธแล้ว\n${reportLine(res.quote)}\nรบกวนทีมงานตามลูกค้าห้อง …${res.quote.conversation_suffix} ต่อเองนะคะ`,
      };
    }

    case "show": {
      const quote = store.get(command.quoteId);
      if (!quote) return { reply: `❌ ไม่พบ ${command.quoteId}` };
      const trail = quote.audit
        .slice(-6)
        .map((a) => `  ${a.at.slice(0, 19).replace("T", " ")} ${a.actor} ${a.action}${a.to ? ` → ${a.to}` : ""}`)
        .join("\n");
      return { quote, reply: `${reportLine(quote)}\nผู้อนุมัติ: ${quote.approver ?? "-"}\n${trail}` };
    }

    case "confirm": {
      /*
       * เส้นเดียวที่ใบกลายเป็น "ยืนยันชำระแล้ว"
       * ใบที่ยังไม่ถึง "รับสลิปแล้ว" จะถูกปฏิเสธและเขียนร่องรอยไว้ โดยสถานะไม่ขยับ
       * (ดูเหตุผลใน store.confirmPayment() ที่ src/quotes.js)
       */
      const res = confirmPayment(command.quoteId, { store, approver });
      return { quote: res.quote, reply: res.reply, customerMessages: res.customerMessages };
    }

    case "today": {
      const list = store.list({ day: day() });
      if (list.length === 0) return { reply: "วันนี้ยังไม่มีใบเสนอราคาค่ะ" };
      return { reply: `ใบเสนอราคาวันนี้ ${list.length} ใบ\n${list.map(reportLine).join("\n")}` };
    }

    default:
      return null;
  }
}
