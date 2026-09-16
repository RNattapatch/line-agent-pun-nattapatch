/*
 * Card Studio — ประกอบการ์ด LINE Flex จาก template ใน cards/ + ราคาจาก products.md
 *
 * เส้นแบ่งที่จงใจไว้:
 *   - หน้าตาการ์ดอยู่ใน cards/templates/*.json ไม่ได้ฝังใน JS
 *     เจ้าของร้านอยากเปลี่ยนสี เปลี่ยนคำบนปุ่ม แก้ JSON แล้วรีสตาร์ต ไม่ต้องแตะโค้ด
 *   - ราคามาจาก products.md เสมอ (src/price-source.js) ห้ามพิมพ์ราคาลง template
 *   - ปุ่มใช้ action ชนิด "message" ไม่ใช่ "postback" — ลูกค้ากดแล้วกลายเป็นข้อความ
 *     ที่ไหลเข้าท่อเดิมทั้งหมด (พักข้อความ → กฎตายตัว → สมองร้าน) และไปเข้าความจำ
 *     บทสนทนาให้ด้วย ทำให้ลูกค้ากด "สนใจรุ่นนี้" แล้วถามต่อว่า "มีรูปไหม" ระบบรู้ว่ารุ่นไหน
 *   - รูปต้องผ่าน src/image-verify.js ก่อนเสมอ (ดู verifiedProductCard)
 *     การ์ดที่รูปพังส่งสำเร็จเงียบ ๆ ได้ ต่างจาก message ชนิด image ที่ LINE ปฏิเสธให้เอง
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getImage, toPublicUrl } from "./image-cache.js";
import { formatBaht, formatPrice, priceOf } from "./price-source.js";
import { bySlug } from "./products.js";
import { verifyImageUrl } from "./image-verify.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const CARDS_DIR = path.join(ROOT, "cards");
const TEMPLATE_DIR = path.join(CARDS_DIR, "templates");

const templates = new Map();

/* อ่าน template ครั้งเดียวแล้วจำไว้ — เหมือนแคชรูปกับสมองร้าน แก้ไฟล์แล้วต้องรีสตาร์ต */
export function loadTemplate(name, { dir = TEMPLATE_DIR, reload = false } = {}) {
  const key = path.join(dir, `${name}.json`);
  if (!reload && templates.has(key)) return templates.get(key);

  const tpl = JSON.parse(fs.readFileSync(key, "utf8"));
  templates.set(key, tpl);
  return tpl;
}

export function loadKeywords({ dir = CARDS_DIR } = {}) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "keywords.json"), "utf8"));
  } catch {
    // ไฟล์คีย์เวิร์ดหายไม่ควรทำให้บอททั้งตัวดับ — แค่ตัวส่งการ์ดจะจับ intent ไม่ได้
    return { cardIntent: [], quoteIntent: [], paymentMute: [], productKeywords: {} };
  }
}

/*
 * เติมค่าลง template
 * ค่าที่เป็นสตริง → แทนที่ {{key}} ในข้อความ
 * ค่าที่เป็นอาร์เรย์ → ใช้ได้เฉพาะตอนที่ทั้งช่องเป็น "{{key}}" พอดี (เช่น contents)
 *   เพราะเอาอาร์เรย์ไปต่อกับข้อความไม่ได้ ถ้าเจอปนกันถือว่า template เขียนผิด ให้ระเบิดตั้งแต่เทสต์
 */
export function render(node, values) {
  if (typeof node === "string") {
    const whole = node.match(/^\{\{(\w+)\}\}$/);
    if (whole && whole[1] in values) return values[whole[1]];
    return node.replace(/\{\{(\w+)\}\}/g, (m, k) => {
      const v = values[k];
      if (v === undefined) return m;
      if (Array.isArray(v) || typeof v === "object") {
        throw new TypeError(`placeholder {{${k}}} เป็นอาร์เรย์ ใช้ปนกับข้อความไม่ได้`);
      }
      return String(v);
    });
  }
  if (Array.isArray(node)) return node.map((n) => render(n, values));
  if (node && typeof node === "object") {
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, render(v, values)]));
  }
  return node;
}

const flex = (altText, contents) => ({ type: "flex", altText, contents });

/*
 * การ์ดสินค้า 1 ใบ — คืน null ถ้าประกอบไม่ครบ (ไม่มีสินค้า / ไม่มีราคา / ไม่มีรูป)
 * null แปลว่าผู้เรียกต้องไปใช้ข้อความสำรอง ห้ามส่งการ์ดที่ข้อมูลไม่ครบ
 */
export function productCard(slug, { baseUrl, cache, imageDir, priceList } = {}) {
  const product = bySlug(slug);
  if (!product) return null;

  const price = priceOf(slug, ...(priceList ? [priceList] : []));
  if (!price) return null; // ราคาใน products.md ไม่ครบ — ห้ามออกการ์ดที่ไม่มีราคา

  const entry = getImage(slug, dropUndefined({ cache, imageDir }));
  const url = entry ? toPublicUrl(baseUrl, entry.path) : null;
  if (!url) return null;

  const bubble = render(loadTemplate("product-card"), {
    name: product.name,
    price: formatPrice(price),
    image_url: url,
  });

  /*
   * altText คือข้อความที่โผล่ใน notification และในเครื่องที่แสดง Flex ไม่ได้
   * ห้ามมี path/URL หลุดมาตรงนี้ (context.md ข้อ 6) — ใส่แค่ชื่อกับราคา
   */
  return { message: flex(`${product.name} ${formatPrice(price)}`, bubble), imageUrl: url, slug };
}

/*
 * เวอร์ชันที่ยิงตรวจรูปจริงก่อน — ตัวส่งการ์ดและตัวตอบต้องใช้ตัวนี้
 * แยกจาก productCard() เพื่อให้ตัวประกอบการ์ดยัง pure และเทสต์ได้โดยไม่ต้องต่อเน็ต
 */
export async function verifiedProductCard(slug, options = {}) {
  const card = productCard(slug, options);
  if (!card) return null;
  const ok = await verifyImageUrl(card.imageUrl, options.verify ?? {});
  return ok ? card : null;
}

const row = (label, value, opts = {}) => ({
  type: "box",
  layout: "horizontal",
  contents: [
    { type: "text", text: label, size: "xs", color: opts.color ?? "#666666", flex: 3, wrap: true },
    {
      type: "text",
      text: value,
      size: opts.size ?? "xs",
      color: opts.color ?? "#333333",
      weight: opts.weight ?? "regular",
      align: "end",
      flex: 2,
    },
  ],
});

/* วันหมดอายุแบบที่ลูกค้าอ่านรู้เรื่อง — 16/09/2026 16:30 น. */
const thaiDateTime = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())} น.`;
};

/*
 * การ์ดใบเสนอราคา — ผู้เรียกต้องเช็คสถานะมาก่อนแล้วว่าส่งได้
 * (draft / หมดอายุ / ยกเลิก ห้ามส่ง — ดู canSendQuoteCard ใน src/quotes.js)
 */
export function quoteCard(quote) {
  /* ต้องโชว์ "ราคาต่อหน่วย" ด้วย ไม่ใช่แค่ยอดรวมบรรทัด — ลูกค้าต้องกดเครื่องคิดเลขตามได้เอง
   * ใบเสนอราคาที่โชว์แต่ยอดรวมคือใบที่ลูกค้าต้องเชื่อเราอย่างเดียว ซึ่งไม่ควร */
  const items = quote.items.map((it) =>
    row(`${it.name}\n${it.qty} ${it.unit ?? ""} × ${formatBaht(it.unit_price)} บ.`.trim(), `${formatBaht(it.line_total)} บ.`),
  );

  const totals = [row("ยอดรวม", `${formatBaht(quote.subtotal)} บ.`)];
  if (quote.discount_percent > 0) {
    totals.push(row(`ส่วนลด ${quote.discount_percent}%`, `-${formatBaht(quote.discount_amount)} บ.`));
  }
  totals.push(row("ยอดสุทธิ", `${formatBaht(quote.net)} บ.`, { weight: "bold", size: "sm", color: "#8C6A3F" }));
  totals.push(row(`มัดจำ ${quote.deposit_percent}%`, `${formatBaht(quote.deposit)} บ.`));

  const bubble = render(loadTemplate("quote-card"), {
    quote_id: quote.quote_id,
    items,
    totals,
    expires_at: thaiDateTime(quote.expires_at),
  });

  return flex(`ใบเสนอราคา ${quote.quote_id} ยอดสุทธิ ${formatBaht(quote.net)} บาท`, bubble);
}

/*
 * การ์ดหลายใบเรียงให้ปัดดู — ใช้ตอบคำขอแบบกว้าง ("ขอดูสินค้า" / "เมนู" / "มีอะไรบ้าง")
 *
 * คืน null ถ้าประกอบไม่ได้สักใบ ผู้เรียกต้องตกไปใช้ลิสต์ข้อความแทน
 * ใบไหนประกอบไม่ได้ (ไม่มีรูปในแคช / ราคาใน products.md ไม่ครบ) ก็ข้ามไปเงียบ ๆ
 * ดีกว่าไม่โชว์อะไรเลยเพราะสินค้าตัวเดียวมีปัญหา
 *
 * LINE รับ bubble ได้สูงสุด 12 ใบต่อ 1 ข้อความ — ร้านมี 4 ตัว ยังอีกไกล
 * แต่ตัดไว้กันวันที่เจ้าของร้านเพิ่มสินค้าจนเกิน แล้วการ์ดทั้งก้อนส่งไม่ออกโดยไม่รู้ตัว
 */
export function productCarousel(slugs, options = {}) {
  const built = slugs.map((slug) => productCard(slug, options)).filter(Boolean).slice(0, 12);
  if (built.length === 0) return null;

  const cards = built.map((b) => ({ slug: b.slug, imageUrl: b.imageUrl }));

  /* ใบเดียวไม่ต้องห่อเป็น carousel — bubble เดี่ยวแสดงเต็มจอกว่า อ่านง่ายกว่า */
  if (built.length === 1) return { message: built[0].message, cards };

  return {
    message: flex(`รายการสินค้าของร้าน ${built.length} รายการค่ะ`, {
      type: "carousel",
      contents: built.map((b) => b.message.contents),
    }),
    cards,
  };
}

const dropUndefined = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
