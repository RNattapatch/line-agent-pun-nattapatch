/*
 * ความจำบทสนทนาแบบสั้น — เก็บไว้ในหน่วยความจำเท่านั้น ไม่ลงดิสก์ ไม่ขึ้น repo
 *
 * มีไว้ตอบ 2 คำถามที่โค้ดเดิมตอบไม่ได้:
 *
 *   1. ลูกค้าถาม "มีรูปไหม" เฉย ๆ — หมายถึงรุ่นไหน
 *      ต้องย้อนดู "ทั้งข้อความลูกค้าและคำตอบของร้าน" เพราะบ่อยครั้งคนที่เอ่ยชื่อรุ่นล่าสุด
 *      คือฝั่งร้าน (ลูกค้าถาม "บราวนี่กล่องเท่าไหร่" → ร้านตอบ "บราวนี่ (กล่อง 6 ชิ้น) 189 บาทค่ะ"
 *      → ลูกค้าถาม "มีรูปไหม") ถ้าย้อนดูแต่ฝั่งลูกค้าจะพลาดเคสที่ร้านเป็นคนสรุปรุ่นให้
 *      หาไม่เจอ = ถามกลับ ห้ามเดา (context.md ข้อ 2)
 *
 *   2. ตอนนี้อยู่ในจังหวะชำระเงินหรือเปล่า
 *      ลูกค้าส่งรูปสลิปเข้ามาแล้วพิมพ์ "โอนแล้วค่ะ" — รูปสลิป "ไม่ใช่" ความสนใจสินค้า
 *      ถ้าตัวส่งการ์ดยิงการ์ดสินค้าตามหลังตรงนี้ ลูกค้าจะงงว่าตกลงร้านได้เงินหรือยัง
 *      และดูเหมือนร้านพยายามขายของเพิ่มทั้งที่ยังไม่ยืนยันยอดเดิม
 *
 * ทำไมไม่เก็บลงดิสก์: ข้อความลูกค้าเป็นข้อมูลส่วนบุคคล เก็บเท่าที่จำเป็นและให้หายเองดีที่สุด
 * รีสตาร์ตแล้วความจำหาย = อย่างมากลูกค้าโดนถามกลับว่าหมายถึงรุ่นไหน ซึ่งปลอดภัยอยู่แล้ว
 */

import { matchProduct } from "./products.js";
import { loadKeywords } from "./cards.js";

/* เก็บย้อนหลังกี่ event ต่อ 1 ห้อง — พอสำหรับบทสนทนาหนึ่งรอบ ไม่บวมจนกินแรม */
export const MAX_EVENTS = 20;

/* ห้องที่เงียบเกินนี้ถูกลืมทิ้ง — ลูกค้ากลับมาพรุ่งนี้ถือเป็นบทสนทนาใหม่ */
export const TTL_MS = 12 * 60 * 60 * 1000;

/* ย้อนหาชื่อรุ่นไกลสุดกี่ event — ไกลกว่านี้ถือว่าคนละเรื่องแล้ว */
const LOOKBACK = 10;

/* กี่ event ล่าสุดที่ถือว่ายังอยู่ในจังหวะชำระเงิน */
const PAYMENT_LOOKBACK = 6;

export function createConversations({
  maxEvents = MAX_EVENTS,
  ttlMs = TTL_MS,
  now = () => Date.now(),
  keywords = loadKeywords(),
} = {}) {
  /* chatId -> { events: [...], at } */
  const rooms = new Map();

  const muteWords = (keywords.paymentMute ?? []).filter(Boolean);
  const paymentRe = muteWords.length ? new RegExp(muteWords.join("|"), "i") : /$^/;

  const prune = () => {
    const cutoff = now() - ttlMs;
    for (const [id, room] of rooms) if (room.at < cutoff) rooms.delete(id);
  };

  const get = (chatId) => rooms.get(chatId)?.events ?? [];

  return {
    /*
     * บันทึก 1 event
     *   role "customer" | "shop"
     *   kind "text" | "image" | "other"
     */
    remember(chatId, { role, kind = "text", text = "" } = {}) {
      if (!chatId) return;
      prune();

      let room = rooms.get(chatId);
      if (!room) rooms.set(chatId, (room = { events: [], at: now() }));

      room.events.push({ role, kind, text: String(text ?? ""), at: now() });
      if (room.events.length > maxEvents) room.events.splice(0, room.events.length - maxEvents);
      room.at = now();
    },

    events: get,

    /*
     * รุ่นล่าสุดที่ "มีคนเอ่ยชื่อชัด ๆ" ในห้องนี้ — คืน slug หรือ null
     * ไล่จากใหม่ไปเก่า และรับเฉพาะตอนที่ชี้ได้รุ่นเดียว
     * "บราวนี่" เฉย ๆ ยังกำกวมอยู่ (ชิ้น/กล่อง) จึงไม่นับว่าชัด ต้องถามกลับเหมือนเดิม
     */
    lastProductSlug(chatId, { exclude = [] } = {}) {
      const events = get(chatId);
      for (const ev of events.slice(-LOOKBACK).reverse()) {
        if (ev.kind !== "text" || !ev.text) continue;
        const found = matchProduct(ev.text);
        if (found.match && !exclude.includes(found.match.slug)) return found.match.slug;
      }
      return null;
    },

    /*
     * อยู่ในบริบทชำระเงินไหม — จริงเมื่อข้อใดข้อหนึ่งเป็นจริง
     *   ก. event ล่าสุดของลูกค้าเป็นรูปภาพ (สลิป)
     *   ข. ลูกค้าพิมพ์คำจำพวก โอนแล้ว/สลิป/ชำระ/จ่ายแล้ว ในช่วงหลัง
     * ข้อ ค. (quote อยู่สถานะ ส่งลูกค้า/รับสลิปแล้ว) เช็คที่ตัวส่งการ์ด เพราะต้องอ่านจาก VPS
     */
    inPaymentContext(chatId) {
      const events = get(chatId);
      if (events.length === 0) return false;

      const lastCustomer = [...events].reverse().find((e) => e.role === "customer");
      if (lastCustomer?.kind === "image") return true;

      return events
        .slice(-PAYMENT_LOOKBACK)
        .some((e) => e.role === "customer" && e.kind === "text" && paymentRe.test(e.text));
    },

    forget(chatId) {
      rooms.delete(chatId);
    },

    get size() {
      prune();
      return rooms.size;
    },
  };
}

/* ตัวกลางที่ทั้งเซิร์ฟเวอร์ใช้ร่วมกัน — เทสต์สร้างตัวใหม่ของตัวเองได้ */
export const conversations = createConversations();
