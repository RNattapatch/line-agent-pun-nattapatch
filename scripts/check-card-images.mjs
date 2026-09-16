#!/usr/bin/env node
/*
 * ตรวจรูปบนการ์ดทุกใบ — ต้องเป็นลิงก์ถาวรและตอบ HTTP 200 พร้อม content-type เป็นรูป
 *
 * รันก่อน deploy ทุกครั้ง: `npm run check:cards`
 * ออกด้วย exit code 1 ถ้ามีใบไหนไม่ผ่าน จะได้เอาไปต่อ CI หรือ pre-push hook ได้เลย
 *
 * ทำไมต้องมีสคริปต์แยก ทั้งที่ตอนส่งก็ตรวจอยู่แล้ว:
 * ตอนส่งถ้าตรวจไม่ผ่าน ลูกค้าจะได้ข้อความสำรอง "ยังไม่มีรูปในระบบค่ะ" แล้วไปปลุกแอดมิน
 * ซึ่งแปลว่ากว่าจะรู้ว่ารูปพัง ก็คือตอนลูกค้าถามมาแล้ว — สายไปหนึ่งจังหวะเสมอ
 */

import process from "node:process";

import { loadDotEnv } from "../src/env.js";
import { readCache } from "../src/image-cache.js";
import { productCard } from "../src/cards.js";
import { isPermanentUrl } from "../src/image-verify.js";
import { PRODUCTS } from "../src/products.js";
import { priceList } from "../src/price-source.js";

loadDotEnv();

const baseUrl = process.env.PUBLIC_BASE_URL;
if (!baseUrl?.startsWith("https://")) {
  console.error("❌ PUBLIC_BASE_URL ต้องเป็น https:// — LINE โหลดรูปจาก http ไม่ได้");
  process.exit(1);
}

const cache = readCache();
const prices = priceList({ reload: true });
let failed = 0;

console.log(`ตรวจรูปการ์ด ${PRODUCTS.length} ใบ จาก ${baseUrl}\n`);

for (const product of PRODUCTS) {
  const label = product.name.padEnd(24, " ");
  const card = productCard(product.slug, { baseUrl, cache, priceList: prices });

  if (!card) {
    const why = prices.items.some((i) => i.slug === product.slug)
      ? "ไม่มีรูปในแคช หรือไฟล์หาย/ใหญ่เกิน 1 MB"
      : "ราคาใน products.md ไม่ครบ";
    console.error(`❌ ${label} ประกอบการ์ดไม่ได้ — ${why}`);
    failed++;
    continue;
  }

  if (!isPermanentUrl(card.imageUrl)) {
    console.error(`❌ ${label} ไม่ใช่ลิงก์ถาวร — ${card.imageUrl}`);
    failed++;
    continue;
  }

  /* ยิงจริงทุกครั้ง ไม่ผ่านแคชของ image-verify — จุดประสงค์ของสคริปต์นี้คือ "เช็คของจริงเดี๋ยวนี้" */
  let res;
  try {
    res = await fetch(card.imageUrl, { method: "GET", redirect: "follow" });
  } catch (err) {
    console.error(`❌ ${label} โหลดไม่ได้ — ${err.message}`);
    failed++;
    continue;
  }

  const type = res.headers.get("content-type") ?? "";
  if (res.status !== 200 || !/^image\//i.test(type)) {
    console.error(`❌ ${label} HTTP ${res.status} · ${type || "ไม่มี content-type"}`);
    failed++;
    continue;
  }

  const bytes = Number(res.headers.get("content-length")) || 0;
  console.log(`✅ ${label} 200 · ${type} · ${(bytes / 1024).toFixed(0)} KB`);
}

if (failed > 0) {
  console.error(`\n❌ ไม่ผ่าน ${failed} ใบ — การ์ดที่รูปพังจะขึ้นกรอบเทาในแชทลูกค้าโดยไม่มี error ให้เห็น`);
  process.exit(1);
}

console.log(`\n✅ ผ่านครบทุกใบ`);
