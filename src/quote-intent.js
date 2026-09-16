/*
 * อ่านคำขอใบเสนอราคาจากข้อความลูกค้า — ดึงได้แค่ "รุ่น" กับ "จำนวน" เท่านั้น
 *
 * ⚠️ จงใจไม่มีทางให้ราคาเข้ามาทางนี้
 * ตัวเลขบาทที่ลูกค้าพิมพ์จะถูกเก็บไว้ในช่อง statedAmounts เพื่อ "เอาไปเทียบ" อย่างเดียว
 * ไม่ถูกใช้คิดเงินเด็ดขาด — ยอดทุกบาทมาจาก products.md ผ่าน src/quotes.js
 * (โจทย์: ห้ามแต่งราคา ห้ามรับยอดลอยจากแชท)
 *
 * ลูกค้าพิมพ์ "บราวนี่" เฉย ๆ ยังกำกวมอยู่ (ชิ้น/กล่อง) — คืนไว้ในช่อง ambiguous
 * ให้ผู้เรียกถามกลับ ห้ามเดาให้ (context.md ข้อ 2)
 */

import { AMBIGUOUS, PRODUCTS, bySlug } from "./products.js";
import { loadKeywords } from "./cards.js";

const keywords = loadKeywords();

const anyOf = (words) => (words?.length ? new RegExp(words.map(escapeRe).join("|"), "i") : /$^/);
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const QUOTE_RE = anyOf(keywords.quoteIntent);
const CARD_RE = anyOf(keywords.cardIntent);
const PAYMENT_RE = anyOf(keywords.paymentMute);

export const wantsQuote = (text) => QUOTE_RE.test(String(text ?? ""));
export const wantsCard = (text) => CARD_RE.test(String(text ?? ""));
export const mentionsPayment = (text) => PAYMENT_RE.test(String(text ?? ""));

/* "ลด 10%" · "ส่วนลด 7 เปอร์เซ็น" · "ลดให้ 5 %" */
const DISCOUNT_RE = /(?:ลด|ส่วนลด|discount)\D{0,10}?(\d{1,2}(?:\.\d+)?)\s*(?:%|เปอร์เซ็น[ต์]?|percent)/i;

/* ยอดบาทที่ลูกค้าพิมพ์มาเอง — เก็บไว้เทียบ ไม่ได้เอาไปคิด */
const AMOUNT_RE = /([\d,]+(?:\.\d+)?)\s*(?:บาท|บ\.|฿)/g;

/* จำนวนที่อยู่ติดกับชื่อสินค้า — "3 กล่อง" / "x2" / "2 ชิ้น" */
const QTY_RE = /(?:^|[^\d])(?:x|×)?\s*(\d{1,3})\s*(?:กล่อง|ชิ้น|เซ็ต|เซต|อัน|ชุด|ที่)?/;

/* ตำแหน่งที่ชื่อ/alias ของสินค้าแต่ละตัวโผล่ในข้อความ — เอาตำแหน่งแรกสุด */
function locate(lower) {
  const spots = [];
  for (const p of PRODUCTS) {
    const needles = [p.name, ...p.aliases, ...(keywords.productKeywords?.[p.slug] ?? [])];
    let at = -1;
    let hit = null;
    for (const n of needles) {
      const i = lower.indexOf(String(n).toLowerCase());
      if (i !== -1 && (at === -1 || i < at)) {
        at = i;
        hit = String(n);
      }
    }
    if (at !== -1) spots.push({ slug: p.slug, at, length: hit.length });
  }
  return spots.sort((a, b) => a.at - b.at);
}

/*
 * คืน
 *   items          [{ slug, qty }] — จำนวนที่อ่านได้ ไม่เจอตัวเลขถือว่า 1
 *   ambiguous      [slug, slug]    — ลูกค้าพูดกว้างจนชี้ไม่ได้ ต้องถามกลับ
 *   discountPercent
 *   statedAmounts  [number]        — ยอดบาทที่ลูกค้าพิมพ์มาเอง ไว้เทียบเท่านั้น
 */
export function parseQuoteRequest(input) {
  const text = String(input ?? "");
  const lower = text.toLowerCase();
  const spots = locate(lower);

  const items = [];
  for (let i = 0; i < spots.length; i++) {
    const spot = spots[i];
    const after = text.slice(spot.at + spot.length, spots[i + 1]?.at ?? text.length);
    const before = text.slice(spots[i - 1] ? spots[i - 1].at + spots[i - 1].length : 0, spot.at);

    /*
     * ดูตัวเลขข้างหลังชื่อก่อน ("บราวนี่กล่อง 3 กล่อง") แล้วค่อยถอยไปดูข้างหน้า ("3 กล่อง บราวนี่")
     * ข้างหลังมาก่อนเพราะคนไทยพิมพ์แบบนั้นบ่อยกว่า และตัวเลขข้างหน้าอาจเป็นของสินค้าตัวก่อน
     */
    const qty =
      Number(after.match(QTY_RE)?.[1]) ||
      Number(before.match(new RegExp(`${QTY_RE.source}\\s*$`))?.[1]) ||
      1;

    items.push({ slug: spot.slug, name: bySlug(spot.slug)?.name, qty: Math.min(Math.max(qty, 1), 999) });
  }

  /* ไม่เจอสินค้าเจาะจงเลย — ลองดูว่าพูดคำกว้างที่ชี้ได้หลายรุ่นไหม */
  let ambiguous = [];
  if (items.length === 0) {
    for (const group of AMBIGUOUS) {
      if (group.keywords.some((k) => lower.includes(k.toLowerCase()))) ambiguous = group.slugs;
    }
  }

  const statedAmounts = [...text.matchAll(AMOUNT_RE)].map((m) => Number(m[1].replace(/,/g, "")));

  return {
    items,
    ambiguous,
    discountPercent: Number(text.match(DISCOUNT_RE)?.[1]) || 0,
    statedAmounts,
  };
}
