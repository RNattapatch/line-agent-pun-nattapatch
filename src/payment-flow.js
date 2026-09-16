/*
 * ท่อชำระเงินในแชท — ต่อระหว่างปุ่มบนการ์ดกับด่านออก QR (src/qr-issue.js)
 *
 * ═══ ทุกยอดผูก quote_id ═══
 * ไม่มีทางไหนในไฟล์นี้ที่ตัวเลขยอดเดินทางมาจากข้อความหรือ postback ของลูกค้า
 * postback พกได้แค่ 3 อย่าง: ทำอะไร (action) · ใบไหน (quote_id) · บัญชีไหน + ยอดชนิดไหน
 * ตัวเลขจริงไปหยิบจาก record ตอนกด — การ์ดที่ค้างในแชทเมื่อวานจึงออก QR ยอดเก่าไม่ได้
 *
 * ═══ ข้อความที่ลูกค้าได้ยิน กับที่แอดมินได้ยิน ไม่ใช่ข้อความเดียวกัน ═══
 * ลูกค้าได้ยินว่าเกิดอะไรขึ้นกับออเดอร์ตัวเอง · แอดมินได้ยินว่าต้องไปทำอะไรต่อ
 * เหตุผลการปฏิเสธที่ละเอียด (สถานะไหน ติดด่านไหน) เข้าหูแอดมินอย่างเดียว
 * บอกลูกค้าเท่ากับสอนวิธีลองใหม่ให้ผ่าน
 */

import { paymentCard } from "./cards.js";
import { destinationById, paymentDestinations } from "./payment.js";
import { formatBaht } from "./price-source.js";
import { issueQr } from "./qr-issue.js";
import { STATUS, reportLine } from "./quotes.js";

const text = (t) => ({ type: "text", text: t });

/* ข้อความเดียวที่ใช้ตอบลูกค้าตอนได้รับสลิป — ห้ามพูดอะไรที่ฟังเหมือนยืนยันว่าเงินเข้าแล้ว */
export const SLIP_REPLY = "รับสลิปแล้วนะคะ ขอให้เจ้าหน้าที่ตรวจสอบยอดก่อน แล้วจะยืนยันกลับมาในแชทนี้ค่ะ";

/*
 * ข้อความหลังเจ้าของร้านตรวจยอดในแอปธนาคารแล้วยืนยัน
 *
 * จงใจไม่ระบุว่า "ได้รับยอดเท่าไหร่" — ระบบไม่มีทางรู้ว่าลูกค้าโอนยอดไหนมาจริง
 * (ลูกค้าเลือกได้ทั้งมัดจำและเต็มจำนวน และจะคัดลอกเลขบัญชีไปโอนเองโดยไม่กด QR ก็ได้)
 * ตัวเลขที่เดาเอาแล้วไปโผล่ในข้อความยืนยัน คือตัวเลขที่ลูกค้าจะเอาไปอ้างทีหลัง
 * ยอดคงเหลือเท่าไหร่ให้คนที่เพิ่งเปิดแอปธนาคารดูเป็นคนบอก
 */
export const paidReply = (quote) =>
  [
    `ยืนยันการชำระเงินเรียบร้อยแล้วค่ะ ${quote.quote_id}`,
    "ทางร้านตรวจยอดกับธนาคารแล้ว กำลังเตรียมออเดอร์ให้เลยนะคะ ขอบคุณมากค่ะ 🙏",
  ].join("\n");

/*
 * แกะ postback — คืน null ถ้าไม่ใช่รูปแบบที่เรารู้จัก
 *
 * ปฏิเสธทันทีถ้ามีคีย์ amount/total/price ติดมา ถึงจะไม่มีโค้ดตรงไหนอ่านมันก็ตาม
 * เป็นสัญญาณกันดัก: วันไหนมีคนเติมช่องรับยอดเข้ามาใน postback ไม่ว่าด้วยเจตนาอะไร
 * ต้องพังให้เห็นตั้งแต่เทสต์ ไม่ใช่ค่อย ๆ กลายเป็นทางที่ยอมรับยอดลอยได้เงียบ ๆ
 */
const FORBIDDEN_KEYS = ["amount", "total", "price", "net", "deposit"];

export function parsePostback(data) {
  if (typeof data !== "string" || data.length > 300) return null;

  let params;
  try {
    params = new URLSearchParams(data);
  } catch {
    return null;
  }

  for (const key of FORBIDDEN_KEYS) {
    if (params.has(key)) {
      console.warn(`🚫 postback พกยอดมาเอง (${key}) — ปฏิเสธทั้งคำขอ`);
      return { action: "rejected", reason: "ยอดต้องมาจากใบเสนอราคา ไม่ใช่จาก postback" };
    }
  }

  const action = params.get("action");
  const quoteId = params.get("quote_id");

  if (action !== "qr") return null;
  /* รูปแบบเลขใบต้องตรงเป๊ะ — กันสตริงแปลก ๆ ไปถึงชั้นที่เปิดไฟล์ */
  if (!/^Q-\d{8}-\d{3}$/.test(quoteId ?? "")) return null;

  return {
    action: "qr",
    quoteId,
    destId: params.get("dest") ?? "",
    kind: params.get("kind") === "full" ? "full" : "deposit",
  };
}

/*
 * ประกอบข้อความ "ช่องทางชำระเงิน" ให้ลูกค้า — ใช้ทั้งตอนกดยืนยันสั่งซื้อ และตอนขอซ้ำ
 * คืน { messages, escalate } · ไม่ได้ตั้ง ENV ไว้ = ไม่แจ้งช่องทางเอง ส่งต่อให้คนแจ้ง
 */
export function paymentMessages(quote, { destinations = paymentDestinations() } = {}) {
  if (destinations.length === 0) {
    return {
      messages: [text("ขอให้แอดมินแจ้งช่องทางชำระเงินให้นะคะ รอสักครู่ค่ะ")],
      escalate: `ยังไม่ได้ตั้งช่องทางรับเงิน (PAYMENT_DESTINATIONS_JSON) — แจ้งช่องทางให้ลูกค้าเองด้วยค่ะ ${quote.quote_id}`,
    };
  }

  /* มีมัดจำที่ไม่เท่ายอดเต็ม → ให้เลือกได้ทั้งสองยอด ไม่งั้นปุ่มเดียวพอ */
  const amountKinds = quote.deposit > 0 && quote.deposit !== quote.net ? ["deposit", "full"] : ["full"];
  const card = paymentCard(quote, destinations, { amountKinds });

  if (!card) {
    return {
      messages: [text("ขอให้แอดมินแจ้งช่องทางชำระเงินให้นะคะ รอสักครู่ค่ะ")],
      escalate: `ประกอบการ์ดช่องทางชำระเงินไม่สำเร็จ: ${quote.quote_id}`,
    };
  }

  const due = amountKinds.includes("deposit") ? quote.deposit : quote.net;
  return {
    messages: [
      text(`รับออเดอร์ค่ะ ${quote.quote_id} ยอดที่ต้องโอนตอนนี้ ${formatBaht(due)} บาทค่ะ`),
      card,
    ],
    escalate: null,
  };
}

/* ข้อความที่ลูกค้าได้ยินตอนออก QR ให้ไม่ได้ — แยกตามเหตุ แต่ไม่บอกกลไกข้างใน */
const CUSTOMER_REFUSAL = {
  "not-found": "ขอเช็กใบเสนอราคาให้ก่อนนะคะ เดี๋ยวแจ้งกลับค่ะ",
  "not-yours": "ขอเช็กใบเสนอราคาให้ก่อนนะคะ เดี๋ยวแจ้งกลับค่ะ",
  expired: "ใบเสนอราคาใบนี้เลยกำหนดยืนราคาแล้วค่ะ ขอออกใบใหม่ให้นะคะ แจ้งรายการที่ต้องการได้เลยค่ะ",
  status: "ขอส่งให้เจ้าของร้านยืนยันยอดให้ก่อนนะคะ รอสักครู่ค่ะ",
  "no-destination": "ขอให้แอดมินแจ้งช่องทางชำระเงินให้นะคะ รอสักครู่ค่ะ",
  "bad-destination": "ขอให้แอดมินแจ้งช่องทางชำระเงินให้นะคะ รอสักครู่ค่ะ",
  "bad-amount-kind": "ขอเช็กยอดให้ก่อนนะคะ เดี๋ยวแจ้งกลับค่ะ",
  "bad-amount": "ขอเช็กยอดให้ก่อนนะคะ เดี๋ยวแจ้งกลับค่ะ",
  "render-failed": "ขอส่งเลขบัญชีให้โอนแทนนะคะ เดี๋ยวแอดมินแจ้งอีกทีค่ะ",
};

/*
 * ลูกค้ากดปุ่ม "ขอ QR" — คืน { messages, escalate, quote }
 * baseUrl ต้องเป็น https ที่ LINE เข้าถึงได้จริง ไม่งั้นส่งภาพไม่ได้ (เหมือนรูปสินค้า)
 */
export function handleQrRequest({ store, quoteId, lineUserId, destId, kind, baseUrl, deps = {} } = {}) {
  const list = deps.destinations ?? paymentDestinations();
  const destination = destinationById(destId, list);
  const issue = deps.issueQr ?? issueQr;

  const result = issue({ store, quoteId, lineUserId, destination, amountKind: kind });

  if (!result.ok) {
    /*
     * "ไม่ใช่ใบของคนนี้" ต้องดังกว่าข้ออื่น — แปลว่ามีคนยิง postback ใส่เลขใบที่ไม่ใช่ของตัวเอง
     * ซึ่งไม่ใช่สิ่งที่เกิดจากการกดปุ่มตามปกติ
     */
    const loud = result.reason === "not-yours";
    return {
      messages: [text(CUSTOMER_REFUSAL[result.reason] ?? CUSTOMER_REFUSAL["not-found"])],
      escalate: loud
        ? `🚨 มีคนขอ QR ของใบที่ไม่ใช่ของห้องตัวเอง: ${quoteId}`
        : `ออก QR ให้ลูกค้าไม่ได้ (${result.reason}): ${quoteId}`,
      quote: result.quote,
    };
  }

  const url = qrImageUrl(baseUrl, result.token);
  if (!url) {
    /* ใบถูกเลื่อนเป็น "ส่งลูกค้า" ไปแล้วตอนนี้ แต่ภาพส่งไม่ออก — ต้องมีคนแจ้งเลขบัญชีแทน */
    return {
      messages: [text("ขอให้แอดมินส่ง QR ให้อีกทีนะคะ รอสักครู่ค่ะ")],
      escalate: `ส่ง QR ไม่ได้เพราะ PUBLIC_BASE_URL ไม่ใช่ https — รบกวนส่ง QR ให้ลูกค้าเอง ${quoteId}`,
      quote: result.quote,
    };
  }

  return {
    messages: [
      { type: "image", originalContentUrl: url, previewImageUrl: url },
      text(
        [
          `QR ${result.amountLabel} ${formatBaht(result.amount)} บาท`,
          `${result.destination.label} · ${result.destination.account_name}`,
          "สแกนแล้วเช็กชื่อผู้รับกับยอดให้ตรงก่อนกดโอนนะคะ",
          "โอนเสร็จส่งสลิปเข้ามาในแชทนี้ได้เลยค่ะ",
        ].join("\n"),
      ),
    ],
    escalate: null,
    quote: result.quote,
  };
}

/* URL ของภาพ QR — https เท่านั้น (LINE บังคับ TLS 1.2+ เหมือนรูปสินค้า) */
export function qrImageUrl(baseUrl, token) {
  if (!baseUrl || !token) return null;
  const base = String(baseUrl).replace(/\/+$/, "");
  if (!base.startsWith("https://")) return null;
  return `${base}/qr/${token}.png`;
}

/*
 * เจ้าของร้านพิมพ์ "ยืนยันยอด <quote_id>" ใน admin lane
 * คืน { reply, quote, customerMessages } — ผู้เรียกเป็นคนยิงข้อความหาลูกค้าเอง
 * (pipeline รู้จัก client ส่วนไฟล์นี้ตั้งใจไม่รู้จัก เพื่อให้เทสต์เดินได้โดยไม่ต้องมี LINE)
 */
export function confirmPayment(quoteId, { store, approver = "admin" } = {}) {
  const res = store.confirmPayment(quoteId, approver);

  if (!res.ok) {
    /*
     * ปฏิเสธแล้วต้องไม่มีอะไรวิ่งไปหาลูกค้าเลย — ใบยังอยู่สถานะเดิม
     * ร่องรอยการปฏิเสธถูกเขียนลง audit ไปแล้วที่ store.confirmPayment()
     */
    const trail = res.quote ? `\n${reportLine(res.quote)}` : "";
    return {
      reply: `❌ ${quoteId}: ${res.error}${trail}\nบันทึกความพยายามยืนยันไว้ใน audit แล้วค่ะ`,
      quote: res.quote ?? null,
      customerMessages: [],
    };
  }

  return {
    reply: `✅ ยืนยันชำระแล้ว\n${reportLine(res.quote)}\nแจ้งลูกค้าให้แล้วค่ะ`,
    quote: res.quote,
    customerMessages: [text(paidReply(res.quote))],
  };
}

/* สถานะที่เจ้าของร้านต้องลงมือต่อ — ใช้ประกอบข้อความแจ้งเตือนตอนลูกค้าส่งสลิป */
export const ownerAction = (quote) =>
  quote?.status === STATUS.SLIP ? `ตรวจยอดในแอปธนาคารแล้วพิมพ์: ยืนยันยอด ${quote.quote_id}` : null;
