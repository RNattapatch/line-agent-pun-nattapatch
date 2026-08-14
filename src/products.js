/*
 * แคตตาล็อกสินค้า — ใช้จับคู่ข้อความลูกค้ากับรูปในแคช และใช้เป็นโจทย์ตอน gen รูป
 *
 * ⚠️ `products.md` คือแหล่งราคาที่ถูกต้องเพียงแหล่งเดียว ไฟล์นี้ไม่ใช่
 *    ช่อง price ที่นี่มีไว้ให้ตอบลูกค้าตอนถามรูปเท่านั้น และมีเทสต์
 *    (tests/products.test.js) คอยเทียบกับตารางใน products.md ทุกครั้งที่รัน npm test
 *    ถ้าแก้ราคาใน products.md แล้วลืมแก้ที่นี่ เทสต์จะแดง
 *
 * ห้ามเพิ่มสินค้าที่ไม่มีใน products.md — ของนอกรายการต้องตกไปทาง fallback + ส่งต่อแอดมิน
 */

/*
 * โจทย์กลางของทุกใบ ทำให้รูปทั้งชุดดูเหมือนถ่ายในร้านเดียวกัน:
 * แสงเดียวกัน มุมเดียวกัน พื้นไม้เดียวกัน โทนสีเดียวกัน
 * ท้ายประโยคเป็น negative constraint — ห้ามมีตัวหนังสือ โลโก้ ลายน้ำ มือคน
 */
const STYLE =
  "Soft natural window light from the left, warm neutral tones, " +
  "warm honey-toned natural oak table surface, " +
  "plain softly blurred warm-beige wall background, 45-degree angle, close range, shallow depth of field, " +
  "square composition, subject centered with even margins. " +
  // ย้ำเรื่องตัวหนังสือสองชั้น เพราะรอบแรกโมเดลเติมฉลากมั่ว ๆ ลงบนกล่องน้ำผลไม้เอง
  "All packaging is completely blank and unbranded. " +
  "No text, no letters, no printed labels, no logo, no watermark, no hands, no people.";

const scene = (subject) =>
  `Professional food photography for a Thai homemade bakery. ${subject} ${STYLE}`;

/* มุมบนตรง ๆ — ใช้เฉพาะรูปที่ "จำนวนชิ้น" คือสาระสำคัญ ต้องให้ลูกค้านับตามได้ */
const overhead = (subject) =>
  `Professional food photography for a Thai homemade bakery, shot straight down from directly above (flat lay). ` +
  `${subject} ${STYLE.replace("45-degree angle, close range, ", "")}`;

export const PRODUCTS = [
  {
    slug: "shio-pan",
    name: "ขนมปังชิโอะปัง",
    price: "15 บาท / ชิ้น",
    // เขียนได้หลายแบบ สะกดผิดกันคนละทาง เลยเก็บทุกทางที่เจอบ่อย
    aliases: ["ชิโอะปัง", "ชิโอปัง", "ชิโอะ", "ชิโอ", "ซิโอปัง", "ซิโอะปัง", "shio", "shiopan", "salt bread"],
    prompt: scene(
      "A single Japanese-style shio pan salt butter roll, golden glossy crust, crescent shape, " +
        "flaky and freshly baked, one piece only on a small plain ceramic plate.",
    ),
  },
  {
    slug: "box-set-1",
    name: "Box Set 1",
    price: "59 บาท / เซ็ต",
    aliases: ["box set", "boxset", "บ็อกเซ็ต", "บอกเซ็ต", "บ๊อกเซ็ต", "เซ็ต 1", "เซต 1", "เซ็ต1", "กล่องเซ็ต"],
    prompt: scene(
      "An open kraft-paper gift box containing exactly three items: one slice of banana cake, " +
        "one Japanese shio pan salt roll, and one small plain white juice carton with a straw " +
        "(blank white packaging, absolutely no printing or artwork on it), " +
        "arranged neatly inside, the lid open so all three items are clearly visible.",
    ),
  },
  {
    slug: "brownie-piece",
    name: "บราวนี่ (ชิ้น)",
    price: "39 บาท / ชิ้น",
    aliases: ["บราวนี่ชิ้น", "บราวนี่ 1 ชิ้น", "บราวนี่แบบชิ้น", "brownie piece"],
    prompt: scene(
      "A single square fudgy chocolate brownie, dense and moist with a crackly top, " +
        "one piece only on a small plain ceramic plate.",
    ),
  },
  {
    slug: "brownie-box",
    name: "บราวนี่ (กล่อง 6 ชิ้น)",
    price: "189 บาท / กล่อง",
    aliases: ["บราวนี่กล่อง", "บราวนี่ 6", "บราวนี่ 6 ชิ้น", "กล่อง 6", "brownie box"],
    /*
     * ใบนี้ใช้มุมบนตรง ๆ ต่างจากอีก 3 ใบที่เป็นมุม 45 องศา — จงใจ
     * ลองมุม 45 องศาแล้วโมเดลจัดบราวนี่มา 9 ชิ้น (3x3) ทั้งที่สั่งไป 6
     * ของที่ขายคือ "กล่อง 6 ชิ้น 189 บาท" รูปที่นับแล้วไม่ตรงจำนวนคือเรื่องร้องเรียน
     * มุมบนทำให้กริด 2 แถว × 3 ช่อง ชัดจนโมเดลนับถูก และลูกค้าก็นับตามได้
     */
    prompt: overhead(
      "An open kraft-paper box holding exactly six square fudgy chocolate brownies, " +
        "arranged as two rows of three pieces — 6 pieces in total, not more, not fewer. " +
        "The box fills the frame and every piece is fully visible.",
    ),
  },
];

/*
 * "บราวนี่" เฉย ๆ ชี้ได้สองรายการ (ชิ้น / กล่อง) — ห้ามเดาให้ลูกค้า
 * context.md ข้อ 2 บอกว่าถามกลับดีกว่าเดา กลุ่มนี้เลยไว้ตรวจว่าต้องถามกลับ
 */
export const AMBIGUOUS = [
  {
    keywords: ["บราวนี่", "บราวนี", "brownie"],
    slugs: ["brownie-piece", "brownie-box"],
  },
];

export const bySlug = (slug) => PRODUCTS.find((p) => p.slug === slug);

/*
 * จับคู่ข้อความลูกค้ากับสินค้า
 * คืน { match: product } | { ambiguous: [products] } | { none: true }
 *
 * ไล่ alias ที่เจาะจงก่อน (เช่น "บราวนี่กล่อง") ค่อยตกมาที่คำกว้าง ("บราวนี่")
 * ไม่งั้น "ขอดูรูปบราวนี่กล่อง" จะไปเข้ากรณีกำกวมทั้งที่ลูกค้าบอกชัดแล้ว
 */
export function matchProduct(text) {
  const t = text.toLowerCase();

  const hits = PRODUCTS.filter(
    (p) => t.includes(p.name.toLowerCase()) || p.aliases.some((a) => t.includes(a.toLowerCase())),
  );
  if (hits.length === 1) return { match: hits[0] };
  if (hits.length > 1) return { ambiguous: hits };

  for (const group of AMBIGUOUS) {
    if (group.keywords.some((k) => t.includes(k.toLowerCase()))) {
      return { ambiguous: group.slugs.map(bySlug) };
    }
  }

  return { none: true };
}
