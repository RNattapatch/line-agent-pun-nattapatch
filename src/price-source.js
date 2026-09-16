/*
 * แหล่งราคาเดียวของระบบ — อ่านตัวเลขจากตารางใน `products.md` ตรง ๆ
 *
 * ทำไมต้องมีไฟล์นี้ ทั้งที่มี src/products.js อยู่แล้ว:
 *   products.js เก็บราคาเป็น "ข้อความ" ("15 บาท / ชิ้น") ไว้โชว์ลูกค้าตอนถามรูป
 *   พอมีใบเสนอราคาที่ต้องคูณจำนวน หักส่วนลด คิดมัดจำ เราต้องการ "ตัวเลข"
 *   ถ้าไปพิมพ์ตัวเลขซ้ำไว้ในโค้ด วันที่เจ้าของร้านขึ้นราคาใน products.md
 *   ใบเสนอราคาจะยังใช้ราคาเก่าเงียบ ๆ ซึ่งเป็นเงินจริงของร้าน
 *   ตรงนี้จึง parse ตารางใน products.md เป็นตัวเลขทุกครั้งที่บูต — ไฟล์เดียวจบ
 *
 * ช่องที่เขียนว่า "ยังไม่ระบุ" หรือไม่ใช่ตัวเลข = ราคาไม่ครบ
 * ห้ามเดา ห้ามคำนวณต่อ ต้องส่งต่อคน (โจทย์ข้อ "ราคาใน products.md ไม่ครบ")
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PRODUCTS } from "./products.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const PRICE_FILE = path.join(ROOT, "products.md");

/* หัวตารางที่ใช้ยึด — ถ้าเจ้าของร้านเปลี่ยนหัวตาราง เราอยากให้ parser เงียบไม่ได้ */
const HEADER = ["#", "ชื่อสินค้า", "ราคา (บาท)", "หน่วย"];

const cells = (line) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

const isSeparator = (row) => row.every((c) => /^:?-{2,}:?$/.test(c));

/*
 * อ่านตารางราคา คืน
 *   items   — รายการที่มีราคาเป็นตัวเลขใช้ได้จริง
 *   missing — รายการที่มีชื่อแต่ราคายังไม่ระบุ (ต้องส่งต่อคน ห้ามเดา)
 *   checksum— ลายนิ้วมือของตาราง เก็บลง audit ของใบเสนอราคา
 *             วันหลังมีดราม่าเรื่องราคา จะรู้ได้ว่าใบนั้นออกตอนตารางหน้าตาแบบไหน
 */
export function loadPriceList({ file = PRICE_FILE } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    // อ่านไฟล์ไม่ได้ = ไม่มีแหล่งราคา ห้ามเดาราคาแทน ให้ทุกอย่างตกไปทางส่งต่อคน
    return { items: [], missing: [], checksum: null, ok: false };
  }

  const lines = raw.split("\n");
  const start = lines.findIndex((l) => {
    if (!l.trim().startsWith("|")) return false;
    const row = cells(l);
    return HEADER.every((h, i) => row[i] === h);
  });

  if (start === -1) return { items: [], missing: [], checksum: null, ok: false };

  const items = [];
  const missing = [];
  const rows = [];

  for (const line of lines.slice(start + 1)) {
    if (!line.trim().startsWith("|")) break; // จบตารางแล้ว
    const row = cells(line);
    if (isSeparator(row)) continue;
    if (row.length < 4) continue;

    const [, name, priceText, unit] = row;
    if (!name) continue;
    rows.push(row.slice(1, 4).join("|"));

    /* ยอมรับเฉพาะตัวเลขล้วน ๆ — "ยังไม่ระบุ" / "ตามจริง" / ว่าง ถือว่าไม่ครบ */
    const price = /^\d+(\.\d+)?$/.test(priceText.replace(/,/g, ""))
      ? Number(priceText.replace(/,/g, ""))
      : null;

    if (price === null) {
      missing.push({ name, unit, reason: priceText || "(ว่าง)" });
      continue;
    }

    items.push({
      name,
      unit,
      price,
      /* สตางค์ — คิดเงินด้วยจำนวนเต็มเสมอ กัน 0.1 + 0.2 ของทศนิยมลอยตัว */
      satang: Math.round(price * 100),
      slug: PRODUCTS.find((p) => p.name === name)?.slug ?? null,
    });
  }

  return {
    items,
    missing,
    checksum: crypto.createHash("sha256").update(rows.join("\n")).digest("hex").slice(0, 16),
    ok: items.length > 0,
  };
}

let cached = null;

/* อ่านครั้งเดียวตอนบูต เหมือนแคชรูปกับสมองร้าน — แก้ products.md แล้วต้องรีสตาร์ต */
export function priceList({ reload = false } = {}) {
  if (reload || !cached) cached = loadPriceList();
  return cached;
}

/* หาราคาจาก slug — คืน null ถ้าไม่มีหรือราคายังไม่ระบุ (ผู้เรียกต้องส่งต่อคน) */
export function priceOf(slug, list = priceList()) {
  return list.items.find((i) => i.slug === slug) ?? null;
}

/* ข้อความราคาสำหรับการ์ด — ประกอบจากตัวเลขในตาราง ไม่พิมพ์ซ้ำไว้ที่อื่น */
export const formatPrice = (entry) =>
  entry ? `${entry.price.toLocaleString("th-TH")} บาท / ${entry.unit}` : null;

/* บาทสำหรับโชว์ — 1172.5 → "1,172.50" */
export const formatBaht = (baht) =>
  Number(baht).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
