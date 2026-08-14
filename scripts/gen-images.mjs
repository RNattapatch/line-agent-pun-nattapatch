#!/usr/bin/env node
/*
 * สร้างรูปสินค้าล่วงหน้าทีเดียวจบ แล้วเก็บลงเครื่อง — รันตอนไหนก็ได้ ไม่เกี่ยวกับตอนลูกค้าทัก
 *
 *   npm run gen:images                  สร้างเฉพาะตัวที่ยังไม่มีรูป (รันซ้ำได้ ไม่เสียเงินซ้ำ)
 *   npm run gen:images -- --only shio-pan       สร้างใหม่เฉพาะตัวนี้
 *   npm run gen:images -- --force               สร้างใหม่ทั้ง 4 ใบ ทับของเดิม
 *   npm run gen:images -- --list                ดูรายการ slug กับสถานะรูป
 *
 * ทำไมต้อง pre-generate: การ gen 1 ใบใช้เวลาราว 50 วินาที แต่ LINE รอ webhook แค่ ~10 วินาที
 * ถ้า gen ตอนลูกค้าทัก จะตอบด้วย replyMessage ไม่ทัน ต้องไปใช้ pushMessage ที่กินโควตารายเดือน
 *
 * ค่าใช้จ่าย: 4 เครดิต/รูป (google/nano-banana) → ครบชุด 4 ใบ = 16 เครดิต
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { loadDotEnv } from "../src/env.js";
import { PRODUCTS, bySlug } from "../src/products.js";
import { CACHE_FILE, IMAGE_DIR, MAX_PREVIEW_BYTES, readCache, writeCache } from "../src/image-cache.js";
import { MODEL, downloadTo, generateImage, getCredits, redact } from "../src/kie.js";

loadDotEnv();

const args = process.argv.slice(2);
const force = args.includes("--force");
const only = args[args.indexOf("--only") + 1];
const wantList = args.includes("--list");

const cache = readCache();

if (wantList) {
  for (const p of PRODUCTS) {
    const entry = cache.products?.[p.slug];
    const onDisk = entry && fs.existsSync(path.join(IMAGE_DIR, path.basename(entry.path)));
    console.log(`${onDisk ? "✅" : "⬜️"}  ${p.slug.padEnd(14)} ${p.name}`);
  }
  process.exit(0);
}

if (args.includes("--only") && !bySlug(only)) {
  console.error(`❌ ไม่รู้จักสินค้า "${only ?? ""}" — ดูรายชื่อด้วย npm run gen:images -- --list`);
  process.exit(1);
}

const targets = PRODUCTS.filter((p) => {
  if (only) return p.slug === only;
  if (force) return true;
  return !fs.existsSync(path.join(IMAGE_DIR, `${p.slug}.jpg`));
});

if (!targets.length) {
  console.log("✅ มีรูปครบทุกตัวแล้ว — ถ้าอยากเปลี่ยนรูปใช้ --force หรือ --only <slug>");
  process.exit(0);
}

fs.mkdirSync(IMAGE_DIR, { recursive: true });

console.log(`🎨 model: ${MODEL} · จะสร้าง ${targets.length} ใบ (~4 เครดิต/ใบ)`);
try {
  console.log(`💳 เครดิตคงเหลือก่อนเริ่ม: ${await getCredits()}`);
} catch (err) {
  // เช็คเครดิตไม่ได้ไม่ใช่เหตุให้หยุด แค่บอกไว้
  console.warn(`⚠️  เช็คเครดิตไม่ได้: ${redact(err.message)}`);
}

const failures = [];

/*
 * ยิงทีละใบ ไม่ยิงพร้อมกัน — เพดานของ kie.ai คือ 20 คำขอ/10 วินาที
 * แค่ 4 ใบไม่ชนเพดานอยู่แล้ว แต่การทำทีละใบทำให้ log อ่านง่ายและเห็นชัดว่าใบไหนพัง
 */
const MAX_ATTEMPTS = 3;
const kb = (bytes) => `${Math.round(bytes / 1000)} KB`;

for (const product of targets) {
  process.stdout.write(`\n🖼  ${product.name} (${product.slug})\n`);
  const dest = path.join(IMAGE_DIR, `${product.slug}.jpg`);
  let saved = null;

  /*
   * ขนาดไฟล์ที่โมเดลคืนมาแกว่งอยู่ราว 530 KB – 1 MB คุมตรง ๆ ไม่ได้
   * ใบที่บังเอิญเกินเพดาน preview ของ LINE เลยสั่งใหม่ให้เอง (เสียเพิ่มใบละ 4 เครดิต)
   * ดีกว่าปล่อยรูปที่ LINE โหลดไม่ขึ้นไปถึงลูกค้า
   */
  for (let attempt = 1; attempt <= MAX_ATTEMPTS && !saved; attempt++) {
    try {
      const { taskId, url, credits } = await generateImage(product.prompt, {
        aspectRatio: "1:1",
        outputFormat: "jpeg",
        onState: (state, progress) =>
          process.stdout.write(`\r   ⏳ ${state ?? "..."}${progress ? ` ${progress}%` : ""}      `),
      });
      process.stdout.write("\r                          \r");

      const { bytes } = await downloadTo(url, dest);

      if (bytes > MAX_PREVIEW_BYTES) {
        fs.unlinkSync(dest);
        if (attempt < MAX_ATTEMPTS) {
          console.log(`   ↻ ได้ ${kb(bytes)} เกินเพดาน preview ${kb(MAX_PREVIEW_BYTES)} — สั่งใหม่ (ครั้งที่ ${attempt + 1})`);
          continue;
        }
        throw new Error(`ได้ไฟล์เกินเพดาน preview ของ LINE ${MAX_ATTEMPTS} ครั้งติด (${kb(bytes)}) — ลองรันใหม่อีกที`);
      }

      saved = { bytes, taskId, credits };
    } catch (err) {
      // redact กัน API key ติดไปกับข้อความ error (repo นี้เป็น public)
      console.error(`   ❌ ${redact(err.message)}`);
      break;
    }
  }

  if (!saved) {
    failures.push(product.slug);
    continue;
  }

  cache.products[product.slug] = {
    name: product.name,
    path: `/images/${product.slug}.jpg`,
    bytes: saved.bytes,
    model: MODEL,
    taskId: saved.taskId,
    generatedAt: new Date().toISOString(),
  };
  writeCache(cache);

  console.log(`   ✅ ${kb(saved.bytes)} → public/images/${product.slug}.jpg (${saved.credits} เครดิต)`);
}

// แตะไฟล์แคชเฉพาะตอนที่มีรูปใหม่จริง ๆ — run ที่ล้มเหลวทั้งยวงไม่ควรทิ้ง diff ไว้ใน git
if (failures.length < targets.length) {
  cache.updatedAt = new Date().toISOString();
  writeCache(cache);
  console.log(`\n📄 อัปเดตแล้ว: ${path.relative(process.cwd(), CACHE_FILE)}`);
}

try {
  console.log(`💳 เครดิตคงเหลือ: ${await getCredits()}`);
} catch {
  /* ไม่สำคัญพอจะให้ทั้ง script พัง */
}

if (failures.length) {
  console.error(`\n⚠️  ยังขาดรูป: ${failures.join(", ")} — รันซ้ำได้ ตัวที่สำเร็จแล้วจะไม่ถูกสร้างใหม่`);
  console.error("   ระหว่างนี้บอทจะตอบลูกค้าด้วยข้อความสำรองแล้วส่งต่อแอดมิน ไม่มีรูปพังหลุดไปหาลูกค้า");
  process.exit(1);
}

console.log("\n🎉 ครบทุกใบ");
