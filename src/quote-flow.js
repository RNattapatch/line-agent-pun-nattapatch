/*
 * ท่อใบเสนอราคาในแชท — ต่อระหว่างข้อความลูกค้ากับ Quote Engine (src/quotes.js)
 *
 * ลำดับที่ตั้งใจให้เป็น:
 *   ลูกค้าขอราคา → คิดยอดจาก products.md → ตรวจอัตโนมัติ
 *     ผ่าน   → "ตรวจแล้ว" → ส่งการ์ดใบเสนอราคา → "ส่งลูกค้า"
 *     ไม่ผ่าน → คง "draft" · แจ้งเจ้าของร้านพร้อม quote_id + เหตุผล · ลูกค้าได้แค่ "ขอส่งให้เจ้าของร้านดูให้นะคะ"
 *              ห้ามส่งการ์ด ห้ามออก QR จนกว่าจะมีคำสั่งอนุมัติจาก Admin lane
 *
 * ช่องทางชำระเงินไม่ถูกส่งไปพร้อมใบเสนอราคา — context.md ข้อ 7 บอกว่า
 * "ยืนยันยอดกับลูกค้าก่อนทุกครั้งก่อนแจ้งช่องทางชำระเงิน"
 * ลูกค้าต้องกดปุ่ม "ยืนยันสั่งซื้อ" บนการ์ดก่อน ถึงจะได้การ์ดช่องทางชำระเงิน
 * แล้วต้องกด "ขอ QR" อีกทีถึงจะได้ภาพ QR ที่ผูกกับยอดของใบนั้น (ดู src/payment-flow.js)
 */

import { quoteCard } from "./cards.js";
import { SLIP_REPLY, ownerAction, paymentMessages } from "./payment-flow.js";
import { formatBaht } from "./price-source.js";
import { STATUS, canIssueQr, canSendQuoteCard, reportLine } from "./quotes.js";

const text = (t) => ({ type: "text", text: t });

/* ปุ่ม "ยืนยันสั่งซื้อ" บนการ์ดส่งข้อความนี้กลับมา */
export const CONFIRM_RE = /^ยืนยันสั่งซื้อ\s+(Q-\d{8}-\d{3})\s*$/i;

/*
 * ลูกค้าพิมพ์ยอดมาเอง แล้วยอดนั้นไม่ตรงกับที่คิดได้จาก products.md
 * ห้ามรับยอดนั้นมาใช้เด็ดขาด แต่ก็ห้ามเงียบ — เพราะแปลว่าลูกค้ากับร้านเข้าใจไม่ตรงกัน
 * ส่งใบที่ถูกต้องไปตามปกติ แล้วแปะธงให้คนไปคุยต่อ
 */
function amountMismatch(parsed, quote) {
  const known = new Set([quote.net, quote.subtotal, quote.deposit, ...quote.items.map((i) => i.line_total), ...quote.items.map((i) => i.unit_price)]);
  return (parsed.statedAmounts ?? []).filter((a) => a > 0 && !known.has(a));
}

/*
 * ลูกค้าขอใบเสนอราคา — คืน { messages, escalate, quote }
 * store ส่งเข้ามาเพื่อให้เทสต์ชี้ไปโฟลเดอร์ชั่วคราวได้ ไม่ต้องแตะ ~/shop-data จริง
 */
export function handleQuoteRequest(parsed, { store, chatId, lineUserId } = {}) {
  const { quote, ok, reasons } = store.create({
    lineUserId,
    chatId,
    requested: parsed.items.map((i) => ({ slug: i.slug, qty: i.qty, name: i.name })),
    discountPercent: parsed.discountPercent,
    actor: "bot",
  });

  /* ของนอกตาราง / ราคายังไม่ระบุ — ไม่ออกเลขใบให้ ส่งต่อคนตั้งแต่ต้นทาง */
  if (!quote) {
    return {
      messages: [text("ขอเช็กราคากับเจ้าของร้านให้ก่อนนะคะ เดี๋ยวแจ้งกลับค่ะ")],
      escalate: `ออกใบเสนอราคาไม่ได้: ${reasons.join(" · ")}`,
      quote: null,
    };
  }

  if (!ok) {
    /*
     * เกินเพดานส่วนลด หรือยอดเกินเกณฑ์ — คง draft
     * ลูกค้าได้ยินแค่ว่ากำลังให้เจ้าของร้านดูให้ (context.md ข้อ 5) ไม่ได้ยินตัวเลขเพดาน
     * เพราะบอกไปเท่ากับสอนให้ต่อรองมาที่ขอบพอดีทุกครั้ง
     */
    return {
      messages: [text("ขอส่งให้เจ้าของร้านดูให้นะคะ รอสักครู่ค่ะ")],
      escalate: [
        `🧾 ใบเสนอราคารอเจ้าของร้านอนุมัติ`,
        reportLine(quote),
        `เหตุผล: ${reasons.join(" · ")}`,
        `อนุมัติ: อนุมัติใบเสนอ ${quote.quote_id}`,
        `ปฏิเสธ: ปฏิเสธใบเสนอ ${quote.quote_id}`,
      ].join("\n"),
      quote,
    };
  }

  return sendQuote(quote, { store, parsed });
}

/*
 * ส่งการ์ดใบเสนอราคาให้ลูกค้า แล้วเลื่อนสถานะเป็น "ส่งลูกค้า"
 * ใช้ทั้งตอนตรวจอัตโนมัติผ่าน และตอนเจ้าของร้านเพิ่งกดอนุมัติ
 */
export function sendQuote(quote, { store, parsed } = {}) {
  if (!canSendQuoteCard(quote)) {
    return {
      messages: [text("ขอส่งให้เจ้าของร้านดูให้นะคะ รอสักครู่ค่ะ")],
      escalate: `ยังส่งการ์ดใบเสนอราคาไม่ได้ (สถานะ ${quote.status}): ${quote.quote_id}`,
      quote,
    };
  }

  const messages = [
    quoteCard(quote),
    text(`ยอดสุทธิ ${formatBaht(quote.net)} บาท มัดจำ ${formatBaht(quote.deposit)} บาทค่ะ ยืนยันสั่งซื้อได้ที่ปุ่มบนใบเสนอราคาเลยค่ะ`),
  ];

  const moved = quote.status === STATUS.REVIEWED ? store.advance(quote.quote_id, STATUS.SENT, { actor: "bot" }) : null;
  const current = moved?.quote ?? quote;

  const mismatch = parsed ? amountMismatch(parsed, current) : [];

  return {
    messages,
    escalate: mismatch.length
      ? `⚠️ ลูกค้าพิมพ์ยอดมาเอง (${mismatch.join(", ")} บาท) ไม่ตรงกับยอดที่คิดจาก products.md — ส่งใบที่ถูกต้องไปแล้ว รบกวนเช็คกับลูกค้า\n${reportLine(current)}`
      : null,
    quote: current,
  };
}

/*
 * ลูกค้ากดปุ่ม "ยืนยันสั่งซื้อ" — ตรงนี้คือจุดเดียวที่ช่องทางชำระเงินออกจากระบบ
 *
 * เช็ค 3 ชั้นก่อนแจ้งเลขบัญชี:
 *   1. ใบนี้เป็นของห้องนี้จริงไหม — quote_id เดาได้ (Q-วันที่-เลขรัน) ถ้าไม่เช็ค
 *      ลูกค้าคนหนึ่งจะพิมพ์เลขใบของคนอื่นแล้วเห็นยอดของคนอื่นได้
 *   2. สถานะออก QR ได้ไหม — draft / หมดอายุ / ยกเลิก ห้ามออกเด็ดขาด
 *   3. ตั้งช่องทางรับเงินไว้ใน ENV จริงไหม (ดู src/payment.js)
 */
export function handleConfirm(quoteId, { store, chatId } = {}) {
  const quote = store.get(quoteId);

  if (!quote || (quote.chat_id && chatId && quote.chat_id !== chatId)) {
    return {
      messages: [text("ขอเช็กใบเสนอราคาให้ก่อนนะคะ เดี๋ยวแจ้งกลับค่ะ")],
      escalate: `ลูกค้าอ้างถึงใบเสนอราคาที่ไม่ใช่ของห้องตัวเอง: ${quoteId}`,
      quote: null,
    };
  }

  if (quote.status === STATUS.EXPIRED) {
    return {
      messages: [text("ใบเสนอราคาใบนี้เลยกำหนดยืนราคาแล้วค่ะ ขอออกใบใหม่ให้นะคะ")],
      escalate: `ลูกค้ายืนยันใบที่หมดอายุแล้ว: ${reportLine(quote)}`,
      quote,
    };
  }

  if (!canIssueQr(quote)) {
    return {
      messages: [text("ขอส่งให้เจ้าของร้านยืนยันยอดให้ก่อนนะคะ รอสักครู่ค่ะ")],
      escalate: `ลูกค้ายืนยันใบที่ยังออก QR ไม่ได้ (สถานะ ${quote.status}): ${quote.quote_id}`,
      quote,
    };
  }

  /*
   * ถึงตรงนี้แปลว่าผ่านด่านครบแล้ว — ส่งการ์ดช่องทางชำระเงิน
   * เลขบัญชีกับชื่อผู้รับเงินมาจาก ENV เท่านั้น (ดู src/payment.js)
   * ไม่ออก QR ให้ตั้งแต่ตรงนี้ ลูกค้าต้องกดปุ่ม "ขอ QR" บนการ์ดอีกที
   * เพราะ QR ผูกกับยอดเดียว ออกทิ้งไว้ตั้งแต่ยังไม่มีใครขอ = ภาพค้างในแชทที่อาจถูกใช้ผิดยอดทีหลัง
   */
  const payment = paymentMessages(quote);
  return { ...payment, quote };
}

/*
 * ลูกค้าส่งสลิป (รูป) เข้ามาระหว่างที่มีใบสถานะ "ส่งลูกค้า" ค้างอยู่
 * เลื่อนเป็น "รับสลิปแล้ว" แล้วให้คนไปตรวจยอดจริงในแอปธนาคาร
 * บอทไม่ยืนยันเองว่าเงินเข้าแล้ว — อ่านสลิปจากรูปไม่ได้ และสลิปปลอมมีจริง
 */
export function handleSlip({ store, chatId, lineUserId } = {}) {
  const open = store.byUser(lineUserId ?? chatId).find((q) => q.status === STATUS.SENT);
  if (!open) return null;

  store.advance(open.quote_id, STATUS.SLIP, { actor: "bot", note: "ลูกค้าส่งรูปเข้ามา" });

  /*
   * ก่อนเจ้าของร้านตรวจยอดจริง ลูกค้าต้องได้ยินแค่ "รับสลิปแล้ว รอตรวจ" เท่านั้น
   * ห้ามมีคำไหนที่ฟังแล้วเหมือนยืนยันว่าเงินเข้าแล้ว — บอทอ่านสลิปจากรูปไม่ได้
   * และสลิปปลอมใช้เวลาทำไม่กี่วินาที ถ้าบอทรับปากไปก่อน ร้านจะเสียของฟรีโดยที่ลูกค้าก็ไม่ผิด
   */
  const current = store.get(open.quote_id);
  return {
    messages: [text(SLIP_REPLY)],
    escalate: [
      "💸 ลูกค้าส่งสลิปแล้ว รบกวนเช็คยอดในแอปธนาคาร",
      reportLine(current),
      ownerAction(current),
    ]
      .filter(Boolean)
      .join("\n"),
    quote: current,
  };
}
