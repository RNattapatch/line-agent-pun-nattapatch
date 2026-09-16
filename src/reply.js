/*
 * ตรรกะการตอบลูกค้า — แยกออกจาก server.js เพื่อให้เทสต์ได้โดยไม่ต้องเปิดเซิร์ฟเวอร์จริง
 *
 * กติกาที่ห้ามละเมิด (context.md ข้อ 6):
 *   - ห้ามพูดว่า "สร้างรูปภาพไม่ได้"
 *   - ห้ามบอกว่าตัวเองเป็น AI / บอท / โมเดล
 *   - ห้ามอธิบาย error ทางเทคนิคให้ลูกค้าฟัง
 *   - รูปขาด / ของนอกรายการ / ระบบมีปัญหา → ตอบ NO_IMAGE_REPLY เป๊ะ ๆ แล้วส่งต่อแอดมิน
 *   - ข้อมูลระบบ / รหัส / สิทธิ์แอดมิน → ปฏิเสธตรง ๆ ห้ามรับปากว่าจะให้ใครมาตอบ (src/guard.js)
 *   - ทุกข้อความลงท้าย คะ/ค่ะ
 * มีเทสต์ (tests/reply.test.js) คอยไล่เช็คทั้งหมดนี้ทุกครั้งที่รัน npm test
 *
 * ไฟล์นี้ยัง pure เหมือนเดิม — งานที่ต้องต่อเน็ตถูกส่งกลับไปให้ server.js ทำ ผ่าน 3 ธง:
 *   askBrain     ให้สมองร้านลองตอบ
 *   card         การ์ดที่ประกอบไว้แล้ว แต่ยังต้องเอา imageUrl ไปตรวจ 200 ก่อนส่ง
 *   quoteRequest คำขอใบเสนอราคาที่แกะแล้ว ให้ Quote Engine ไปคิดยอดจาก products.md
 * ธงพวกนี้ทำให้เทสต์ยังไล่ได้ทุกเส้นทางโดยไม่ต้องต่อเน็ตและไม่ต้องมีไฟล์บน VPS
 */

import { PRODUCTS, bySlug, matchProduct } from "./products.js";
import { getStaffImage, toPublicUrl } from "./image-cache.js";
import { needsHuman } from "./brain.js";
import { SECURITY_REPLY, isSecurityProbe, securityEscalation } from "./guard.js";
import { productCard, productCarousel } from "./cards.js";
import { formatPrice, priceOf } from "./price-source.js";
import { parseQuoteRequest, wantsQuote } from "./quote-intent.js";

/* ข้อความสำรอง — เขียนตามที่ context.md ข้อ 6 กำหนดไว้ทุกตัวอักษร ห้ามแก้ถ้อยคำ */
export const NO_IMAGE_REPLY = "รุ่นนี้ยังไม่มีรูปในระบบค่ะ เดี๋ยวแจ้งแอดมินส่งรูปให้นะคะ";

/* ลูกค้าเอารูปไปใช้ตัดสินใจซื้อไม่ได้ (context.md ข้อ 6 ท้ายสุด) — เรื่องนี้ต้องให้คนตอบ */
const REAL_PHOTO_REPLY = "ขอส่งให้แอดมินถ่ายรูปหน้าร้านให้ดูนะคะ รอสักครู่ค่ะ";

const text = (t) => ({ type: "text", text: t });

const image = (url) => ({
  type: "image",
  originalContentUrl: url,
  previewImageUrl: url, // ไฟล์เดียวกันทั้งคู่ได้ — script gen บังคับให้ไม่เกิน 1 MB ตามเพดาน preview ของ LINE
});

/* ลูกค้าขอดูรูปหรือเปล่า */
const asksForImage = (t) => /(รูป|ภาพ|photo|pic|image)/i.test(t);

/*
 * ลูกค้าอยากเห็นพนักงานประจำร้านหรือเปล่า
 * รับทั้ง "ขอดูรูปพนักงาน" และ "ขอดูพนักงานหน่อย" (ไม่มีคำว่ารูปก็เจตนาเดียวกัน)
 */
const asksForStaff = (t) =>
  /(พนักงาน|สตาฟ|สต๊าฟ|staff)/i.test(t) && /(รูป|ภาพ|ดู|เห็น|หน้าตา|photo|pic)/i.test(t);

/*
 * ลูกค้ากำลังถามว่า "ของจริงเหมือนรูปไหม" หรือเปล่า
 * ต้องเช็คก่อน asksForImage เพราะประโยคพวกนี้มีคำว่า "รูป" อยู่ด้วย
 */
const doubtsRealPhoto = (t) =>
  /(ของจริง|ตรงปก|รูปจริง|ถ่ายจริง|เหมือนรูป|หน้าตาแบบนี้|แบบในรูป)/.test(t);

/*
 * ลูกค้าขอดู "ของทั้งร้าน" แบบไม่เจาะจงรุ่นหรือเปล่า
 *
 * เดิมกฎเมนูบังคับให้พิมพ์ว่า "เมนู" เป๊ะ ๆ คำเดียว คำที่มีหางอย่าง
 * "ขอดูเมนูทั้งหมดครับ" จึงหลุดไปให้สมองร้านแต่งเมนูเอง แล้วสมองเขียน
 * "บราวนี่ 39 บาท/ชิ้น" ทิ้งวงเล็บ (ชิ้น)/(กล่อง) ไป ซึ่งไม่ตรงกับ products.md
 * (เจอจริงในแชทลูกค้า 16 ก.ย. 2026) — ตรงนี้จึงจับให้กว้างขึ้นและตอบด้วยกฎตายตัวแทน
 *
 * ผู้เรียกต้องเช็คก่อนว่าลูกค้า "ไม่ได้" เอ่ยชื่อรุ่นไหนมา ถึงจะใช้ตัวนี้ได้
 * ไม่งั้น "ขอดูรายการบราวนี่" จะกลายเป็นโชว์ทั้งร้านแทนที่จะตอบเรื่องบราวนี่
 */
const BROWSE_NOUN = /(สินค้า|เมนู|รายการ|แคตตาล็อก|แคตาล็อก|catalog|menu|ขนม|เบเกอรี่)/i;
const BROWSE_INTENT = /(ดู|ขอ|มี|ขาย|อะไร|บ้าง|ทั้งหมด|แนะนำ|สนใจ|เอา)/;

/*
 * ต้องมี "คำที่ชี้ถึงของทั้งร้าน" คู่กับ "ท่าทีอยากเห็น" ถึงจะนับ
 * จะจับแค่คำว่า "อะไรบ้าง" เฉย ๆ ไม่ได้ เพราะ "มีโปรอะไรบ้าง" / "ส่งวันไหนได้บ้าง"
 * เป็นคำถามคนละเรื่อง ที่สมองร้านตอบได้ดีกว่าการโยนการ์ดสินค้าใส่
 */
/* พิมพ์คำเดียวโดด ๆ ("เมนู") ก็คือขอดูของทั้งร้าน ไม่ต้องมีคำขออะไรเพิ่ม */
const BARE_BROWSE = /^\s*(เมนู|สินค้า|รายการ(สินค้า)?|แคตตาล็อก|แคตาล็อก|catalog|menu)\s*$/i;

const asksToBrowse = (t) => BARE_BROWSE.test(t) || (BROWSE_NOUN.test(t) && BROWSE_INTENT.test(t));

/* ราคาบนเมนูมาจากตารางใน products.md เสมอ ตกลงมาที่ค่าในแคตตาล็อกเฉพาะตอนตารางอ่านไม่ได้ */
const menuLine = (p) => `• ${p.name} ${formatPrice(priceOf(p.slug)) ?? p.price}`;

/*
 * คำที่ "ไม่ได้ระบุตัวสินค้า" — ใช้ตัดทิ้งเพื่อดูว่าลูกค้าเอ่ยชื่อของอะไรมาจริง ๆ หรือเปล่า
 *
 * รวมคำกว้างอย่าง "ขนมปัง" / "ขนม" / "ร้าน" ด้วย เพราะกว่าจะมาถึงตรงนี้
 * matchProduct() ไม่เจอสินค้าไปแล้ว — "ขนมปังชิโอะปัง" จึงถูกจับตั้งแต่ก่อนหน้า
 * เหลือมาที่นี่แปลว่าลูกค้าพูดกว้าง ๆ ("ขอดูรูปขนมปังของร้าน") ควรยื่นรายการให้เลือก
 * ไม่ใช่ตอบว่าไม่มีรูป ซึ่งเคยเกิดจริงและไปรบกวนแอดมินฟรี ๆ
 */
const GENERIC_WORD_LIST = [
  "ขอ", "ดู", "มี", "ไหม", "หน่อย", "ค่ะ", "ครับ", "คะ", "ค่า", "จ้า", "นะ", "ที",
  "รูป", "ภาพ", "สินค้า", "เมนู", "ทั้งหมด", "อะไรบ้าง", "อะไร", "บ้าง",
  "ขนมปัง", "ขนม", "เบเกอรี่", "ของ", "ร้าน", "นี้", "นั้น", "แบบ", "ไหน", "ตัว", "อัน", "ๆ",
];

/*
 * เรียงคำยาวก่อนเสมอ — regex alternation ของ JS เลือกตัวซ้ายสุดที่แมตช์ ไม่ใช่ตัวที่ยาวที่สุด
 * ถ้าเรียงตามใจ "ของ" จะโดน "ขอ" ชิงไปกินก่อน เหลือ "ง" ค้างจนระบบนึกว่าลูกค้า
 * เอ่ยชื่อของนอกรายการ (เคยเกิดจริงกับ "ขอดูรูปขนมปังของร้านครับ" ใน log)
 * เรียงตรงนี้ทีเดียว คนเพิ่มคำใหม่ทีหลังจะได้ไม่ต้องระวังลำดับเอง
 */
const GENERIC_WORDS = new RegExp(
  `(${[...GENERIC_WORD_LIST].sort((a, b) => b.length - a.length).join("|")}|\\s)`,
  "g",
);

/*
 * คืน { messages, escalate, askBrain?, card?, quoteRequest? }
 *   messages     ข้อความที่จะส่งกลับลูกค้า (ตามรูปแบบ message object ของ LINE)
 *   escalate     เหตุผลที่ต้องส่งต่อแอดมิน หรือ null ถ้าไม่ต้อง
 *   card         { slug, imageUrl } ของการ์ดที่อยู่ใน messages — server.js ต้องเอา
 *                imageUrl ไปตรวจ 200 ก่อนส่งจริง และไปปั๊มกันส่งซ้ำที่ตัวส่งการ์ด
 *   quoteRequest คำขอใบเสนอราคาที่แกะแล้ว ให้ Quote Engine คิดยอดต่อ
 *
 * lastSlug คือรุ่นล่าสุดที่มีคนเอ่ยชื่อในห้องนี้ (src/conversation.js)
 * ใช้ตอบคำขอรูปที่ไม่เอ่ยรุ่น เช่น "มีรูปไหม" — ไม่มีให้ก็ถามกลับเหมือนเดิม ไม่เดา
 *
 * deps รับเข้ามาเพื่อให้เทสต์ยัดแคชปลอมได้ (เช่น จำลองว่ารูปหาย)
 */
export function buildReply(input, { baseUrl, cache, imageDir, lastSlug = null } = {}) {
  const t = String(input ?? "").trim();

  /*
   * ด่านแรกสุด ก่อนกฎอื่นทั้งหมด — คนล้วงข้อมูลระบบหรือขอสิทธิ์แอดมิน (ดู src/guard.js)
   * ต้องมาก่อนเรื่องรูปด้วย ไม่งั้น "ขอดูรูปหน้าจอ admin panel" จะไปเข้าทางรูปแทน
   * ปฏิเสธด้วยข้อความตายตัว และ "ไม่" ตั้ง askBrain — เรื่องนี้ไม่ให้สมองตัดสินเด็ดขาด
   */
  if (isSecurityProbe(t)) {
    return { messages: [text(SECURITY_REPLY)], escalate: securityEscalation(t) };
  }

  /*
   * เช็คก่อน doubtsRealPhoto — รูปพนักงานเป็นรูปถ่ายจริง ไม่ใช่รูป gen
   * ประโยคอย่าง "พนักงานหน้าตาแบบนี้เหรอ" เลยไม่ต้องส่งต่อแอดมินขอรูปจริง
   */
  if (asksForStaff(t)) return staffReply({ baseUrl, cache, imageDir });

  if (asksForImage(t) && doubtsRealPhoto(t)) {
    return { messages: [text(REAL_PHOTO_REPLY)], escalate: "ลูกค้าขอรูปถ่ายสินค้าจริง" };
  }

  if (asksForImage(t)) return imageReply(t, { baseUrl, cache, imageDir, lastSlug });

  /*
   * ลูกค้าขอใบเสนอราคา — แกะแค่รุ่นกับจำนวน แล้วส่งธงให้ Quote Engine คิดยอดจาก products.md
   * ข้อความที่คืนตรงนี้เป็น "ทางสำรอง" ถ้า Quote Engine ทำงานไม่ได้เลย (ดิสก์เต็ม / ไฟล์พัง)
   * server.js จะเขียนทับด้วยการ์ดใบเสนอราคาจริงเมื่อคิดยอดสำเร็จ
   * เขียนแบบนี้เพราะพลาดฝั่ง "ส่งต่อคน" ยังขายของได้ แต่พลาดฝั่ง "เงียบหาย" ลูกค้าหลุดมือ
   */
  if (wantsQuote(t)) {
    const parsed = parseQuoteRequest(t);

    if (parsed.items.length === 0) {
      const options = (parsed.ambiguous.length ? parsed.ambiguous : PRODUCTS.map((p) => p.slug))
        .map((slug) => bySlug(slug))
        .filter(Boolean);
      return {
        messages: [
          text(`${options.map(menuLine).join("\n")}\nรับเป็นตัวไหน จำนวนเท่าไหร่ดีคะ`),
        ],
        escalate: null,
      };
    }

    return {
      messages: [text("ขอส่งให้เจ้าของร้านสรุปยอดให้นะคะ รอสักครู่ค่ะ")],
      escalate: "ลูกค้าขอใบเสนอราคา",
      quoteRequest: parsed,
    };
  }

  if (/^(สวัสดี|หวัดดี|hi|hello)/i.test(t)) {
    return {
      messages: [text("สวัสดีค่ะ ร้านขนมปัง สดสดสด ยินดีให้บริการค่ะ พิมพ์ 'เมนู' เพื่อดูรายการสินค้าได้เลยค่ะ")],
      escalate: null,
    };
  }

  /*
   * ขอดูของทั้งร้านแบบไม่เจาะจงรุ่น → ส่งการ์ดทั้งหมดให้ปัดดู
   * เช็คว่าไม่มีชื่อรุ่นในประโยคก่อน — เอ่ยรุ่นมาแล้วต้องตอบเรื่องรุ่นนั้น ไม่ใช่เหมาโชว์ทั้งร้าน
   */
  /*
   * needsHuman() ต้องชนะเสมอ — "ขนมบูดขอคืนเงินหน่อย" มีทั้งคำว่า "ขนม" และ "ขอ"
   * จึงเข้าเงื่อนไขขอดูของทั้งร้านได้เต็ม ๆ ทั้งที่เป็นเรื่องร้องเรียน
   * ยิงการ์ดขายของใส่คนที่กำลังโกรธคือทางที่แย่ที่สุดที่จะตอบ (context.md ข้อ 5)
   */
  if (!needsHuman(t) && asksToBrowse(t) && matchProduct(t).none) {
    return browseReply({ baseUrl, cache, imageDir });
  }

  /*
   * กฎตายตัวตอบไม่ได้ — ส่งต่อให้สมองร้าน (src/brain.js) ลองตอบก่อน
   * askBrain เป็นแค่ "ธง" ไม่ใช่การเรียก network จริง เพื่อให้ buildReply ยัง pure
   * และเทสต์ยังไล่ทุกเส้นทางได้โดยไม่ต้องต่อเน็ต — server.js เป็นคนเรียกจริง
   * ถ้าสมองตอบไม่ได้ ลูกค้าจะได้ข้อความชุดนี้แทน (เท่ากับพฤติกรรมเดิมเป๊ะ)
   */
  return {
    messages: [text("รับทราบค่ะ เดี๋ยวแอดมินมาตอบให้นะคะ")],
    escalate: "ข้อความที่บอทยังตอบเองไม่ได้",
    askBrain: !needsHuman(t),
  };
}

/*
 * การ์ดสินค้าทั้งร้านเรียงให้ปัดดู — ใช้ตอบคำขอแบบกว้างทุกทาง
 * ("ขอดูสินค้า" · "เมนู" · "มีอะไรบ้าง" · "ขอดูรูปหน่อย" ที่ไม่บอกรุ่น)
 *
 * slugs รับเข้ามาได้เพื่อให้ server.js ประกอบใหม่จากเฉพาะใบที่รูปตรวจผ่าน 200
 * ประกอบไม่ได้สักใบ → ตกไปใช้ลิสต์ข้อความเหมือนเดิม ลูกค้ายังได้เห็นรายการกับราคา
 * ดีกว่าเงียบ และยังไม่มีศัพท์เทคนิคหลุดออกไป (context.md ข้อ 6)
 */
export function browseReply({ baseUrl, cache, imageDir } = {}, slugs = PRODUCTS.map((p) => p.slug)) {
  const built = productCarousel(slugs, dropUndefined({ baseUrl, cache, imageDir }));

  if (!built) {
    return {
      messages: [text(`${PRODUCTS.map(menuLine).join("\n")}\nสนใจตัวไหนบอกได้เลยค่ะ`)],
      escalate: null,
    };
  }

  return {
    messages: [built.message, text("ปัดดูได้เลยค่ะ สนใจตัวไหนกดปุ่มบนการ์ดได้เลยนะคะ")],
    escalate: null,
    cards: built.cards,
  };
}

/*
 * รูปพนักงานประจำร้าน — น้องแมว 2 ตัวของร้าน เป็นรูปถ่ายจริง
 * ถ้ารูปหาย/แคชพัง ให้ตอบสั้น ๆ แล้วส่งต่อแอดมิน เหมือนกรณีรูปสินค้า (ห้ามหลุดศัพท์เทคนิค)
 */
function staffReply({ baseUrl, cache, imageDir }) {
  const entry = getStaffImage(dropUndefined({ cache, imageDir }));
  const url = entry ? toPublicUrl(baseUrl, entry.path) : null;

  if (!url) {
    return {
      messages: [text("เดี๋ยวแจ้งแอดมินส่งรูปพนักงานให้นะคะ รอสักครู่ค่ะ")],
      escalate: "ยังไม่มีรูปพนักงานในระบบ",
    };
  }

  return {
    messages: [image(url), text("นี่คือพนักงานประจำร้านของเราค่ะ ดูแลหน้าร้านทุกวันเลยค่ะ")],
    escalate: null,
  };
}

function imageReply(t, { baseUrl, cache, imageDir, lastSlug }) {
  const found = matchProduct(t);

  // ลูกค้าพูดถึงบราวนี่เฉย ๆ — ชี้ได้ทั้งแบบชิ้นและแบบกล่อง ถามกลับดีกว่าเดา (context.md ข้อ 2)
  if (found.ambiguous) {
    /*
     * ยกเว้นกรณีที่เพิ่งคุยรุ่นนั้นกันอยู่ — ลูกค้าถาม "บราวนี่กล่อง 6 ชิ้นเท่าไหร่"
     * แล้วถามต่อว่า "ขอดูรูปบราวนี่หน่อย" การถามกลับซ้ำอีกรอบทำให้ดูเหมือนร้านไม่ได้ฟัง
     * ยึดจากรุ่นที่มีคนเอ่ยชื่อจริงเท่านั้น ไม่ได้เดาจากความน่าจะเป็น
     */
    const fromContext = found.ambiguous.find((p) => p.slug === lastSlug);
    if (fromContext) return cardReply(fromContext.slug, { baseUrl, cache, imageDir });

    const options = found.ambiguous
      .map((p) => `${p.name} ${formatPrice(priceOf(p.slug)) ?? p.price}`)
      .join(" กับ ");
    return { messages: [text(`มี${options}ค่ะ ดูรูปแบบไหนดีคะ`)], escalate: null };
  }

  if (found.none) {
    /*
     * ขอดูรูปแบบไม่เจาะจง ("ขอดูรูปหน่อย" / "มีรูปสินค้าไหม") → ยื่นรายการให้เลือก
     * เหลือคำอะไรที่ไม่ใช่คำขอ = ลูกค้าเอ่ยชื่อของบางอย่าง แค่ไม่ใช่ของที่ร้านมี
     */
    const leftover = t.replace(GENERIC_WORDS, "");
    if (leftover.length === 0) {
      /*
       * ย้อนบริบทก่อน — "มีรูปไหม" ที่ตามหลังการคุยรุ่นใดรุ่นหนึ่ง หมายถึงรุ่นนั้น
       * ย้อนดูทั้งข้อความลูกค้าและคำตอบของร้าน (ดู src/conversation.js)
       * ไม่มีบริบทให้ยึด = ยื่นรายการให้เลือกเหมือนเดิม ห้ามเดาไปเองว่าเป็นรุ่นไหน
       */
      if (lastSlug) return cardReply(lastSlug, { baseUrl, cache, imageDir });

      /* ไม่มีบริบทให้ยึด → โชว์การ์ดทั้งร้านให้เลือกเอง ดีกว่ายื่นลิสต์ตัวหนังสือแล้วให้พิมพ์ตอบ */
      return browseReply({ baseUrl, cache, imageDir });
    }
    /*
     * ลูกค้าเอ่ยชื่อของที่ไม่มีในรายการ (เช่น เค้กกล้วยหอมแยกชิ้น ครัวซองต์)
     * ห้ามสร้างรูปให้ ห้ามบอกว่าทำไม่ได้ — ตอบข้อความสำรองแล้วส่งต่อแอดมิน
     */
    return { messages: [text(NO_IMAGE_REPLY)], escalate: `ลูกค้าขอรูปของนอกรายการ: "${t}"` };
  }

  return cardReply(found.match.slug, { baseUrl, cache, imageDir });
}

/*
 * การ์ดสินค้า 1 ใบ — รูป ชื่อ ราคา และปุ่ม "สนใจรุ่นนี้" / "นัดดูสินค้า"
 *
 * ประกอบการ์ดไม่ได้ (ไม่มีรูปในแคช / ไฟล์หาย / ราคาใน products.md ไม่ครบ /
 * ยังไม่ได้ตั้ง PUBLIC_BASE_URL เป็น https) → ลูกค้าเห็นข้อความเดียวกันหมด
 * ไม่มีศัพท์เทคนิคหลุดออกไป ส่วนรายละเอียดไปโผล่ที่ log ของแอดมิน
 */
function cardReply(slug, { baseUrl, cache, imageDir }) {
  const card = productCard(slug, dropUndefined({ baseUrl, cache, imageDir }));

  if (!card) {
    const name = bySlug(slug)?.name ?? slug;
    return { messages: [text(NO_IMAGE_REPLY)], escalate: `ยังไม่มีรูป/ราคาในระบบ: ${name}` };
  }

  return { messages: [card.message], escalate: null, card: { slug, imageUrl: card.imageUrl } };
}

/* ตัด key ที่เป็น undefined ออก เพื่อให้ค่า default ใน getImage ทำงาน */
const dropUndefined = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
