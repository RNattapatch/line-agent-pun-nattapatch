/*
 * ท่อสลิป — ลูกค้าส่งรูปเข้ามาแล้วยังไงต่อ
 *
 * ═══ กติกาข้อเดียวที่ห้ามละเมิดเด็ดขาด ═══
 * รูปเพียงลำพัง "ห้าม" เปลี่ยนสถานะการเงินไม่ว่ากรณีใด
 *
 * บอทอ่านตัวเลขจากรูปไม่ได้ และต่อให้อ่านได้ สลิปปลอมก็ทำเสร็จในไม่กี่วินาที
 * สิ่งเดียวที่รูปบอกได้คือ "ลูกค้าส่งอะไรบางอย่างเข้ามา" เท่านั้น
 * จะนับว่าเป็นสลิปของใบไหน ต้องให้ลูกค้ายืนยันเองก่อนทุกครั้ง
 *
 * ═══ คำที่ห้ามพูดกับรูปที่ยังไม่เข้าเกณฑ์ ═══
 * ห้ามใช้คำว่า สลิป / ยอด / ชำระ กับรูปของลูกค้าที่ไม่มีใบค้างอยู่
 * เพราะพูดไปแล้วลูกค้าจะเข้าใจว่าร้าน "รับเรื่องการโอน" ไว้แล้ว ทั้งที่ยังไม่มีอะไรเกิดขึ้นเลย
 * แล้ววันหลังจะกลายเป็นข้อโต้แย้งว่าร้านยืนยันไปแล้วหรือยัง
 *
 * ═══ เส้นทางทั้งหมด ═══
 *   ไม่มีใบค้าง            → ข้อความกลาง ๆ + ส่งรูปให้เจ้าของเป็นเคสทั่วไป
 *   มีใบค้าง 1 ใบ          → ถามยืนยันพร้อม quote_id + ยอด (ปุ่ม ใช่/ไม่ใช่)
 *   มีใบค้างหลายใบ         → ให้เลือกใบก่อน
 *   ลูกค้าตอบ "ใช่"         → เปลี่ยนเป็น "รับสลิปแล้ว" + ส่งรูปให้เจ้าของพร้อม quote_id
 *   ตอบ "ไม่ใช่" / เงียบ 10 นาที → ส่งรูปให้เจ้าของเป็นเคสทั่วไป ไม่แตะสถานะการเงิน
 */

import { formatBaht } from "./price-source.js";
import { STATUS } from "./quotes.js";

/* เงียบเกินเท่านี้ถือว่าไม่ตอบ แล้วส่งรูปให้เจ้าของเป็นเคสทั่วไป */
export const CONFIRM_TTL_MS = 10 * 60 * 1000;

/* ข้อความตอบรูปที่ไม่เข้าเกณฑ์ — ห้ามมีคำว่า สลิป/ยอด/ชำระ */
export const NEUTRAL_IMAGE_REPLY = "รับรูปไว้แล้วนะคะ เดี๋ยวทีมงานดูให้ค่ะ";

/* คำที่ห้ามหลุดไปกับรูปที่ยังไม่เข้าเกณฑ์ — มีเทสต์กวาดไว้ */
export const MONEY_WORDS = /สลิป|ยอด|ชำระ|โอนเงิน|มัดจำ/;

const text = (t) => ({ type: "text", text: t });

const YES = "ใช่ค่ะ";
const NO = "ไม่ใช่ค่ะ";

/* ลูกค้ากดปุ่มยืนยัน — ปุ่มส่งข้อความนี้กลับมา */
export const CONFIRM_YES_RE = /^ใช่ค่ะ$/;
export const CONFIRM_NO_RE = /^ไม่ใช่ค่ะ$/;
export const PICK_QUOTE_RE = /^เลือก\s+(Q-\d{8}-\d{3})\s*$/i;

/*
 * ใบที่ "สลิปอาจเป็นของใบนี้" — ต้องเป็น "ส่งลูกค้า" และยังไม่หมดอายุเท่านั้น
 * draft/ตรวจแล้ว ยังไม่เคยถึงมือลูกค้า จึงเป็นไปไม่ได้ที่ลูกค้าจะโอนตามใบนั้น
 * ส่วน "รับสลิปแล้ว" คือส่งมาแล้วรอบหนึ่ง ไม่ควรผูกซ้ำโดยอัตโนมัติ
 */
export function eligibleQuotes(store, lineUserId, now = () => new Date()) {
  if (!lineUserId) return [];
  return store
    .byUser(lineUserId)
    .filter((q) => q.status === STATUS.SENT && new Date(q.expires_at).getTime() > now().getTime());
}

const quickReply = (labels) => ({
  items: labels.map((label) => ({
    type: "action",
    action: { type: "message", label, text: label },
  })),
});

/* ข้อความถามยืนยัน — ต้องมี quote_id และยอดเสมอ ลูกค้าจะได้รู้ว่ากำลังตอบเรื่องใบไหน */
export function confirmQuestion(quote) {
  return {
    type: "text",
    text: `รับรูปไว้แล้วนะคะ — เป็นสลิปโอนของใบเสนอราคา ${quote.quote_id} ยอด ${formatBaht(quote.deposit)} บาท ใช่ไหมคะ`,
    quickReply: quickReply([YES, NO]),
  };
}

/* หลายใบ → ให้เลือกก่อน ห้ามเดาว่าเป็นใบไหน */
export function pickQuestion(quotes) {
  const lines = quotes.map((q) => `• ${q.quote_id} ยอด ${formatBaht(q.deposit)} บาท`);
  return {
    type: "text",
    text: ["รับรูปไว้แล้วนะคะ ตอนนี้มีใบเสนอราคาค้างอยู่หลายใบ", ...lines, "รบกวนเลือกใบที่โอนมานะคะ"].join("\n"),
    quickReply: quickReply(quotes.slice(0, 12).map((q) => `เลือก ${q.quote_id}`)),
  };
}

/*
 * ที่พักคำถามยืนยัน — อยู่ในหน่วยความจำเท่านั้น
 *
 * ไม่ลงดิสก์เพราะเป็นสถานะชั่วคราวอายุ 10 นาที และ "หายแล้วปลอดภัย":
 * รีสตาร์ตแล้วคำถามหาย = ลูกค้าตอบ "ใช่" มาแล้วไม่มีใครรับ ซึ่งจบลงที่รูปถูกส่งให้เจ้าของ
 * เป็นเคสทั่วไป — ปลอดภัยกว่าการจำสถานะการเงินค้างข้ามการ deploy
 */
export function createSlipWaiters({ ttlMs = CONFIRM_TTL_MS, now = () => Date.now() } = {}) {
  const waiting = new Map(); // chatId -> { mediaId, quotes, askedAt }

  const prune = () => {
    for (const [id, w] of waiting) if (now() - w.askedAt >= ttlMs) waiting.delete(id);
  };

  return {
    ask(chatId, { mediaId, quotes }) {
      waiting.set(chatId, { mediaId, quotes, askedAt: now() });
    },
    /* คำถามที่ยังรอคำตอบอยู่ — null ถ้าไม่มีหรือหมดเวลาแล้ว */
    pending(chatId) {
      prune();
      return waiting.get(chatId) ?? null;
    },
    clear(chatId) {
      waiting.delete(chatId);
    },
    /* คำถามที่เพิ่งหมดเวลา — คืนพร้อมลบทิ้ง เพื่อเอาไปส่งรูปให้เจ้าของเป็นเคสทั่วไป */
    expired() {
      const out = [];
      for (const [id, w] of waiting) {
        if (now() - w.askedAt >= ttlMs) {
          out.push({ chatId: id, ...w });
          waiting.delete(id);
        }
      }
      return out;
    },
    get size() {
      prune();
      return waiting.size;
    },
  };
}

/*
 * ลูกค้าส่งรูปเข้ามา — คืนสิ่งที่ต้องทำต่อ โดยยังไม่แตะสถานะการเงินใด ๆ ทั้งสิ้น
 *
 *   { kind: "neutral" }  ไม่มีใบค้าง → ข้อความกลาง ๆ + ส่งรูปให้เจ้าของเป็นเคสทั่วไป
 *   { kind: "confirm" }  ใบเดียว → ถามยืนยัน
 *   { kind: "pick" }     หลายใบ → ให้เลือก
 */
export function classifyImage({ store, lineUserId, now = () => new Date() } = {}) {
  const quotes = eligibleQuotes(store, lineUserId, now);

  if (quotes.length === 0) return { kind: "neutral", quotes: [], messages: [text(NEUTRAL_IMAGE_REPLY)] };
  if (quotes.length === 1) return { kind: "confirm", quotes, messages: [confirmQuestion(quotes[0])] };
  return { kind: "pick", quotes, messages: [pickQuestion(quotes)] };
}

/*
 * ลูกค้ายืนยันว่า "ใช่" — จุดเดียวที่สถานะขยับเป็น "รับสลิปแล้ว"
 * ห้ามขยับไป "ยืนยันชำระแล้ว" เด็ดขาด นั่นเป็นสิทธิ์ของเจ้าของร้านหลังเช็กธนาคารจริง (MP-07)
 */
export function acceptSlip(quoteId, { store, actor = "customer-confirmed" } = {}) {
  const quote = store.get(quoteId);
  if (!quote) return { ok: false, error: "ไม่พบใบเสนอราคานี้" };
  if (quote.status !== STATUS.SENT) {
    return { ok: false, error: `ใบนี้สถานะ "${quote.status}" ไม่ใช่ใบที่รอสลิป`, quote };
  }

  const moved = store.advance(quoteId, STATUS.SLIP, { actor, note: "ลูกค้ายืนยันเองว่าเป็นสลิปของใบนี้" });
  return moved.ok ? { ok: true, quote: moved.quote } : { ok: false, error: moved.error, quote };
}
