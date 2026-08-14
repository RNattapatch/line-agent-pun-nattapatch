/*
 * แคชรูปสินค้า — ตัวกลางระหว่าง script ที่ gen รูป กับบอทที่ตอบลูกค้า
 *
 * ตอนบอทตอบลูกค้าจะอ่านจากไฟล์นี้อย่างเดียว ไม่แตะ kie.ai เลย
 * ทำให้ตอบได้ในไม่กี่มิลลิวินาที ทันโควตา 10 วินาทีของ LINE และไม่เสียเงินเพิ่มต่อการถาม 1 ครั้ง
 *
 * image-cache.json เก็บ path ไม่ใช่ URL เต็ม เพราะโดเมนเปลี่ยนตามที่ deploy
 * (ngrok ตอนเทส / โดเมนจริงตอนขึ้น production) — ตัวโดเมนมาจาก PUBLIC_BASE_URL ตอนรัน
 * ไฟล์นี้เลย commit ขึ้น public repo ได้ ไม่มีความลับ
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const CACHE_FILE = path.join(ROOT, "image-cache.json");
export const IMAGE_DIR = path.join(ROOT, "public", "images");

/*
 * LINE: originalContentUrl ไม่เกิน 10 MB · previewImageUrl ไม่เกิน 1 MB · รับเฉพาะ JPEG/PNG
 * เราส่งไฟล์เดียวกันทั้งสองช่อง เพดานที่บังคับจริงเลยเป็น 1 MB
 *
 * ใช้ 1,000,000 ไม่ใช่ 1,048,576 — เอกสาร LINE เขียนแค่ "1 MB" ไม่ได้บอกว่านับฐาน 2 หรือฐาน 10
 * ไฟล์ 1,009,345 ไบต์อยู่ใต้ 1 MiB ก็จริง แต่เกิน 1 MB แบบทศนิยม
 * เลือกเลขที่ปลอดภัยกับทั้งสองการตีความ ดีกว่าเสี่ยงให้ลูกค้าเห็นรูปพัง
 */
export const MAX_PREVIEW_BYTES = 1_000_000;

export function readCache(file = CACHE_FILE) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return { products: {}, ...raw };
  } catch {
    // ยังไม่เคยรัน gen:images หรือไฟล์เสีย — ถือว่าไม่มีรูป แล้วให้ตกไปทางข้อความสำรอง
    return { products: {} };
  }
}

export function writeCache(cache, file = CACHE_FILE) {
  fs.writeFileSync(file, `${JSON.stringify(cache, null, 2)}\n`);
}

/*
 * คืนข้อมูลรูปของสินค้า ถ้าครบพร้อมส่งจริง ๆ เท่านั้น
 * "ครบ" = มีใน cache + ไฟล์อยู่บนดิสก์จริง + ขนาดไม่เกินเพดานของ LINE
 * ถ้าขาดข้อใดข้อหนึ่งให้คืน null แล้วผู้เรียกไปใช้ข้อความสำรอง — ห้ามส่ง URL ที่รูปพังไปหาลูกค้า
 */
export function getImage(slug, { cache = readCache(), imageDir = IMAGE_DIR } = {}) {
  const entry = cache.products?.[slug];
  if (!entry?.path) return null;

  const file = path.join(imageDir, path.basename(entry.path));
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_PREVIEW_BYTES) return null;

  return entry;
}

/* ประกอบ URL เต็มให้ LINE — ต้องเป็น HTTPS เท่านั้น (LINE บังคับ TLS 1.2+) */
export function toPublicUrl(baseUrl, imagePath) {
  if (!baseUrl) return null;
  const base = baseUrl.replace(/\/+$/, "");
  if (!base.startsWith("https://")) return null;
  return `${base}${imagePath.startsWith("/") ? "" : "/"}${imagePath}`;
}
