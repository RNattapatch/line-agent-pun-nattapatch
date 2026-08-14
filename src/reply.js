/*
 * ตรรกะการตอบลูกค้า — แยกออกจาก server.js เพื่อให้เทสต์ได้โดยไม่ต้องเปิดเซิร์ฟเวอร์จริง
 *
 * กติกาที่ห้ามละเมิด (context.md ข้อ 6):
 *   - ห้ามพูดว่า "สร้างรูปภาพไม่ได้"
 *   - ห้ามบอกว่าตัวเองเป็น AI / บอท / โมเดล
 *   - ห้ามอธิบาย error ทางเทคนิคให้ลูกค้าฟัง
 *   - รูปขาด / ของนอกรายการ / ระบบมีปัญหา → ตอบ NO_IMAGE_REPLY เป๊ะ ๆ แล้วส่งต่อแอดมิน
 *   - ทุกข้อความลงท้าย คะ/ค่ะ
 * มีเทสต์ (tests/reply.test.js) คอยไล่เช็คทั้งหมดนี้ทุกครั้งที่รัน npm test
 */

import { PRODUCTS, matchProduct } from "./products.js";
import { getImage, getStaffImage, toPublicUrl } from "./image-cache.js";

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

const menuLine = (p) => `• ${p.name} ${p.price}`;

/*
 * คืน { messages, escalate }
 *   messages — ข้อความที่จะส่งกลับลูกค้า (ตามรูปแบบ message object ของ LINE)
 *   escalate — เหตุผลที่ต้องส่งต่อแอดมิน หรือ null ถ้าไม่ต้อง
 *
 * deps รับเข้ามาเพื่อให้เทสต์ยัดแคชปลอมได้ (เช่น จำลองว่ารูปหาย)
 */
export function buildReply(input, { baseUrl, cache, imageDir } = {}) {
  const t = String(input ?? "").trim();

  /*
   * เช็คก่อน doubtsRealPhoto — รูปพนักงานเป็นรูปถ่ายจริง ไม่ใช่รูป gen
   * ประโยคอย่าง "พนักงานหน้าตาแบบนี้เหรอ" เลยไม่ต้องส่งต่อแอดมินขอรูปจริง
   */
  if (asksForStaff(t)) return staffReply({ baseUrl, cache, imageDir });

  if (asksForImage(t) && doubtsRealPhoto(t)) {
    return { messages: [text(REAL_PHOTO_REPLY)], escalate: "ลูกค้าขอรูปถ่ายสินค้าจริง" };
  }

  if (asksForImage(t)) return imageReply(t, { baseUrl, cache, imageDir });

  if (/^(สวัสดี|หวัดดี|hi|hello)/i.test(t)) {
    return {
      messages: [text("สวัสดีค่ะ ร้านขนมปัง สดสดสด ยินดีให้บริการค่ะ พิมพ์ 'เมนู' เพื่อดูรายการสินค้าได้เลยค่ะ")],
      escalate: null,
    };
  }

  if (t === "เมนู") {
    return {
      messages: [text(`เมนูของร้านค่ะ\n${PRODUCTS.map(menuLine).join("\n")}\nอยากดูรูปตัวไหนบอกได้เลยค่ะ`)],
      escalate: null,
    };
  }

  return { messages: [text("รับทราบค่ะ เดี๋ยวแอดมินมาตอบให้นะคะ")], escalate: "ข้อความที่บอทยังตอบเองไม่ได้" };
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

function imageReply(t, { baseUrl, cache, imageDir }) {
  const found = matchProduct(t);

  // ลูกค้าพูดถึงบราวนี่เฉย ๆ — ชี้ได้ทั้งแบบชิ้นและแบบกล่อง ถามกลับดีกว่าเดา (context.md ข้อ 2)
  if (found.ambiguous) {
    const options = found.ambiguous.map((p) => `${p.name} ${p.price}`).join(" กับ ");
    return { messages: [text(`มี${options}ค่ะ ดูรูปแบบไหนดีคะ`)], escalate: null };
  }

  if (found.none) {
    /*
     * ขอดูรูปแบบไม่เจาะจง ("ขอดูรูปหน่อย" / "มีรูปสินค้าไหม") → ยื่นรายการให้เลือก
     * เหลือคำอะไรที่ไม่ใช่คำขอ = ลูกค้าเอ่ยชื่อของบางอย่าง แค่ไม่ใช่ของที่ร้านมี
     */
    const leftover = t.replace(/(ขอ|ดู|มี|ไหม|หน่อย|ค่ะ|ครับ|คะ|รูป|ภาพ|สินค้า|เมนู|ทั้งหมด|อะไรบ้าง|\s)/g, "");
    if (leftover.length === 0) {
      // รายการขึ้นก่อน แล้วปิดท้ายด้วยคำถาม — ให้ข้อความจบด้วย คะ/ค่ะ ตาม context.md ข้อ 2
      return {
        messages: [text(`${PRODUCTS.map(menuLine).join("\n")}\nดูรูปตัวไหนดีคะ`)],
        escalate: null,
      };
    }
    /*
     * ลูกค้าเอ่ยชื่อของที่ไม่มีในรายการ (เช่น เค้กกล้วยหอมแยกชิ้น ครัวซองต์)
     * ห้ามสร้างรูปให้ ห้ามบอกว่าทำไม่ได้ — ตอบข้อความสำรองแล้วส่งต่อแอดมิน
     */
    return { messages: [text(NO_IMAGE_REPLY)], escalate: `ลูกค้าขอรูปของนอกรายการ: "${t}"` };
  }

  const product = found.match;
  const entry = getImage(product.slug, dropUndefined({ cache, imageDir }));
  const url = entry ? toPublicUrl(baseUrl, entry.path) : null;

  /*
   * ไม่มีรูปในแคช / ไฟล์หาย / ยังไม่ได้ตั้ง PUBLIC_BASE_URL เป็น https
   * ทุกกรณีลูกค้าเห็นข้อความเดียวกัน ไม่มีศัพท์เทคนิคหลุดออกไป ส่วนรายละเอียดไปโผล่ที่ log ของแอดมิน
   */
  if (!url) {
    return { messages: [text(NO_IMAGE_REPLY)], escalate: `ยังไม่มีรูปในระบบ: ${product.name}` };
  }

  return {
    messages: [image(url), text(`${product.name} ${product.price}ค่ะ`)],
    escalate: null,
  };
}

/* ตัด key ที่เป็น undefined ออก เพื่อให้ค่า default ใน getImage ทำงาน */
const dropUndefined = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
