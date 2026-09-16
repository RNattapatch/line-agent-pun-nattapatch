/*
 * จัดหมวดข้อความลูกค้า — ให้ยามทั้งสองตัวมีของนับ
 *
 * ═══ ทำไมเป็นกฎตายตัว ไม่ถามโมเดล ═══
 * ตัวเลขในรายงานเย็นกับเกณฑ์แจ้งด่วนต้องได้ผลเหมือนเดิมทุกครั้งที่รันกับข้อความเดียวกัน
 * ถ้าให้โมเดลจัดหมวด วันหนึ่ง "ขอใบเสนอราคา" จะถูกนับเป็น ask_price อีกวันเป็น ask_quote
 * แล้วกราฟของเจ้าของร้านจะขยับโดยที่พฤติกรรมลูกค้าไม่ได้เปลี่ยนเลย
 *
 * ของแบบนี้ผิดพลาดได้ (คนไทยพิมพ์ได้หลายแบบ) แต่ต้อง "ผิดแบบเดิมทุกครั้ง"
 * เจ้าของร้านจะได้รู้ว่าต้องเติมคีย์เวิร์ดตรงไหน — ดูใน cards/keywords.json
 */

import { loadKeywords } from "./cards.js";

/* เกรด lead ตามสิ่งที่ลูกค้าทำ ไม่ใช่ตามที่พูด */
const HOT = new Set(["ask_quote", "confirm_order", "ask_payment", "send_image"]);
const WARM = new Set(["ask_price", "ask_photo", "ask_delivery"]);

export function gradeOf(intent) {
  if (HOT.has(intent)) return "hot";
  if (WARM.has(intent)) return "warm";
  return "cold";
}

const has = (text, words) => words.some((w) => w && text.includes(w));

/*
 * คืน { intent, lead, triggers }
 *
 * signals คือสิ่งที่ท่อตอบคำนวณไว้แล้ว ส่งเข้ามาเพื่อไม่ต้องเดาซ้ำ:
 *   quoteRequest  ลูกค้าขอใบเสนอราคาจริง (แกะรายการได้แล้ว)
 *   card/cards    ตอบด้วยการ์ดสินค้า
 *   confirmOrder  กดปุ่มยืนยันสั่งซื้อ
 *   image         เป็น event รูป ไม่ใช่ข้อความ
 */
export function classify(input, signals = {}, { keywords = loadKeywords() } = {}) {
  const text = String(input ?? "");
  const k = keywords.urgentTriggers ?? {};

  const triggers = [];
  for (const [trigger, words] of Object.entries(k)) {
    if (has(text, words)) triggers.push(trigger);
  }

  let intent = "other";
  if (signals.image) intent = "send_image";
  else if (signals.confirmOrder) intent = "confirm_order";
  else if (signals.quoteRequest) intent = "ask_quote";
  else if (has(text, keywords.quoteIntent ?? [])) intent = "ask_quote";
  else if (signals.card || signals.cards) intent = "ask_photo";
  else if (has(text, keywords.paymentMute ?? [])) intent = "ask_payment";
  else if (/ราคา|เท่าไหร่|เท่าไร|กี่บาท/.test(text)) intent = "ask_price";
  else if (/รูป|ภาพ|หน้าตา|ดูสินค้า|มีอะไรบ้าง|เมนู/.test(text)) intent = "ask_photo";
  else if (triggers.includes("complaint")) intent = "complaint";
  else if (triggers.includes("ask_owner")) intent = "ask_owner";
  else if (triggers.some((t) => ["delivery_appointment", "pickup_request", "new_appointment"].includes(t))) {
    intent = "ask_delivery";
  } else if (/^(สวัสดี|หวัดดี|ดีค่ะ|ดีครับ|hello|hi)/i.test(text.trim())) intent = "greeting";

  return { intent, lead: gradeOf(intent), triggers };
}
