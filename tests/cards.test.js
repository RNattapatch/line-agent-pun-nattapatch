/*
 * เทสต์ Card Studio — การ์ดต้องมีครบ 4 อย่าง: รูป ชื่อ ราคา ปุ่ม
 * และราคาต้องมาจาก products.md เสมอ ห้ามมีแหล่งราคาที่สอง
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { loadKeywords, loadTemplate, productCarousel, productCard, quoteCard, render } from "../src/cards.js";
import { isPermanentUrl, clearVerifyCache, verifyImageUrl } from "../src/image-verify.js";
import { PRODUCTS } from "../src/products.js";
import { loadPriceList } from "../src/price-source.js";

const BASE = "https://raw.githubusercontent.com/example/repo/main/public";

const fullCache = {
  products: Object.fromEntries(PRODUCTS.map((p) => [p.slug, { name: p.name, path: `/images/${p.slug}.jpg` }])),
};

test("ทุกสินค้าที่ active ใน products.md ประกอบการ์ดได้", () => {
  const prices = loadPriceList();
  assert.ok(prices.items.length > 0, "ต้องอ่านตารางราคาใน products.md ได้");

  for (const entry of prices.items) {
    const card = productCard(entry.slug, { baseUrl: BASE, cache: fullCache });
    assert.ok(card, `${entry.name} ต้องประกอบการ์ดได้`);
    assert.equal(card.imageUrl, `${BASE}/images/${entry.slug}.jpg`);
  }
});

test("ราคาบนการ์ดตรงกับตารางใน products.md เป๊ะ ๆ", () => {
  for (const entry of loadPriceList().items) {
    const card = productCard(entry.slug, { baseUrl: BASE, cache: fullCache });
    const body = JSON.stringify(card.message.contents.body);
    assert.match(body, new RegExp(`${entry.price.toLocaleString("th-TH")} บาท / ${entry.unit}`));
  }
});

test("การ์ดมี CTA ครบ 2 ปุ่มตามที่ร้านกำหนด", () => {
  const card = productCard("brownie-box", { baseUrl: BASE, cache: fullCache });
  const buttons = card.message.contents.footer.contents;

  assert.deepEqual(
    buttons.map((b) => b.action.label),
    ["สนใจรุ่นนี้", "นัดดูสินค้า"],
  );
  /*
   * ปุ่มต้องเป็น action ชนิด message — กดแล้วกลายเป็นข้อความที่ไหลเข้าท่อเดิม
   * และไปเข้าความจำบทสนทนา ทำให้ลูกค้ากดแล้วถามต่อว่า "มีรูปไหม" ระบบรู้ว่ารุ่นไหน
   */
  for (const b of buttons) {
    assert.equal(b.action.type, "message");
    assert.match(b.action.text, /บราวนี่ \(กล่อง 6 ชิ้น\)/);
  }
});

test("altText ของการ์ดต้องไม่มี path หรือ URL หลุด (context.md ข้อ 6)", () => {
  for (const p of PRODUCTS) {
    const card = productCard(p.slug, { baseUrl: BASE, cache: fullCache });
    assert.ok(!/\/images\/|https?:|\.jpe?g/i.test(card.message.altText), `altText หลุด: ${card.message.altText}`);
  }
});

test("ไม่มีรูปในแคช → ไม่ออกการ์ด (ผู้เรียกต้องใช้ข้อความสำรอง)", () => {
  assert.equal(productCard("shio-pan", { baseUrl: BASE, cache: { products: {} } }), null);
});

test("baseUrl ไม่ใช่ https → ไม่ออกการ์ด", () => {
  for (const baseUrl of ["http://shop.example.com", "", undefined]) {
    assert.equal(productCard("shio-pan", { baseUrl, cache: fullCache }), null);
  }
});

test("สินค้าที่ไม่มีใน products.md → ไม่ออกการ์ด", () => {
  assert.equal(productCard("ครัวซองต์", { baseUrl: BASE, cache: fullCache }), null);
});

test("ลิงก์รูปต้องเป็นของถาวร — ที่เก็บชั่วคราวถูกปฏิเสธ", () => {
  assert.ok(isPermanentUrl("https://raw.githubusercontent.com/x/y/main/public/images/a.jpg"));
  assert.ok(isPermanentUrl("https://line-bot.srv1840715.hstgr.cloud/images/a.jpg"));

  for (const bad of [
    "https://tempfile.aiquickdraw.com/abc.jpg", // URL ที่ kie.ai คืนมา หมดอายุ ~24 ชม.
    "https://abc.ngrok-free.app/images/a.jpg",
    "https://abc.trycloudflare.com/a.jpg",
    "http://shop.example.com/a.jpg", // ไม่ใช่ https
    "https://localhost:3000/a.jpg",
    "https://127.0.0.1/a.jpg",
    "ไม่ใช่ URL",
  ]) {
    assert.equal(isPermanentUrl(bad), false, `ต้องปฏิเสธ: ${bad}`);
  }
});

test("verifyImageUrl ผ่านเฉพาะ 200 + content-type เป็นรูป", async () => {
  const reply = (status, type) => async () => ({ status, headers: { get: () => type } });

  clearVerifyCache();
  assert.equal(await verifyImageUrl(`${BASE}/a.jpg`, { fetchImpl: reply(200, "image/jpeg") }), true);

  clearVerifyCache();
  assert.equal(await verifyImageUrl(`${BASE}/b.jpg`, { fetchImpl: reply(404, "text/html") }), false);

  clearVerifyCache();
  assert.equal(await verifyImageUrl(`${BASE}/c.jpg`, { fetchImpl: reply(200, "text/html") }), false, "200 ที่ไม่ใช่รูป (หน้า error ของ CDN) ต้องไม่ผ่าน");

  clearVerifyCache();
  const boom = async () => {
    throw new Error("เน็ตล่ม");
  };
  assert.equal(await verifyImageUrl(`${BASE}/d.jpg`, { fetchImpl: boom }), false, "ไม่ชัวร์ = ไม่ส่ง");
});

test("การ์ดใบเสนอราคาโชว์ครบทุกฟิลด์ที่ร้านกำหนด", () => {
  const quote = {
    quote_id: "Q-20260916-007",
    items: [{ name: "บราวนี่ (กล่อง 6 ชิ้น)", unit: "กล่อง", qty: 3, unit_price: 189, line_total: 567 }],
    subtotal: 567,
    discount_percent: 5,
    discount_amount: 28.35,
    net: 538.65,
    deposit_percent: 50,
    deposit: 269.33,
    expires_at: "2026-09-23T10:00:00.000Z",
  };

  const card = quoteCard(quote);
  const dump = JSON.stringify(card);

  for (const must of [
    "Q-20260916-007",
    "บราวนี่ \\(กล่อง 6 ชิ้น\\)",
    "3 กล่อง × 189.00", // จำนวน × ราคาต่อหน่วย
    "567.00",
    "ส่วนลด 5%",
    "538.65",
    "มัดจำ 50%",
    "269.33",
  ]) {
    assert.match(dump, new RegExp(must), `การ์ดต้องมี ${must}`);
  }
  assert.match(card.altText, /Q-20260916-007/);
});

test("render() ปฏิเสธการเอาอาร์เรย์ไปต่อกับข้อความ", () => {
  assert.throws(() => render({ t: "ก่อน {{items}} หลัง" }, { items: [1, 2] }), TypeError);
  assert.deepEqual(render({ t: "{{items}}" }, { items: [1, 2] }), { t: [1, 2] });
});

test("productCarousel รวมการ์ดทั้งร้านเป็นก้อนเดียว", () => {
  const all = PRODUCTS.map((p) => p.slug);
  const built = productCarousel(all, { baseUrl: BASE, cache: fullCache });

  assert.equal(built.message.contents.type, "carousel");
  assert.equal(built.message.contents.contents.length, PRODUCTS.length);
  assert.deepEqual(built.cards.map((c) => c.slug), all, "ต้องบอกได้ว่ามีใบไหนบ้าง เพื่อเอาไปตรวจรูป");
  assert.ok(!/\/images\/|https?:|\.jpe?g/i.test(built.message.altText), `altText หลุด: ${built.message.altText}`);
});

test("เหลือใบเดียวไม่ต้องห่อเป็น carousel — bubble เดี่ยวแสดงเต็มจอกว่า", () => {
  const built = productCarousel(["shio-pan"], { baseUrl: BASE, cache: fullCache });
  assert.equal(built.message.contents.type, "bubble");
  assert.equal(built.cards.length, 1);
});

test("ใบที่ประกอบไม่ได้ถูกข้ามไป ไม่ล้มทั้งก้อน", () => {
  /* มีรูปแค่ 2 ตัว — ที่เหลือต้องหายไปเงียบ ๆ ไม่ใช่ทำให้ลูกค้าไม่เห็นอะไรเลย */
  const partial = {
    products: {
      "shio-pan": { name: "ขนมปังชิโอะปัง", path: "/images/shio-pan.jpg" },
      "brownie-box": { name: "บราวนี่ (กล่อง 6 ชิ้น)", path: "/images/brownie-box.jpg" },
    },
  };
  const built = productCarousel(PRODUCTS.map((p) => p.slug), { baseUrl: BASE, cache: partial });

  assert.deepEqual(built.cards.map((c) => c.slug), ["shio-pan", "brownie-box"]);
});

test("ประกอบไม่ได้สักใบ → null ให้ผู้เรียกไปใช้ลิสต์ข้อความ", () => {
  assert.equal(productCarousel(PRODUCTS.map((p) => p.slug), { baseUrl: BASE, cache: { products: {} } }), null);
  assert.equal(productCarousel([], { baseUrl: BASE, cache: fullCache }), null);
});

test("cards/ เก็บได้เฉพาะ template กับคีย์เวิร์ด — ห้ามมีข้อมูลลูกค้า", () => {
  const dir = path.resolve(import.meta.dirname, "..", "cards");
  const files = fs.readdirSync(dir, { recursive: true }).map(String);

  for (const f of files) {
    const full = path.join(dir, f);
    if (fs.statSync(full).isDirectory()) continue;
    assert.match(f, /^(README\.md|keywords\.json|templates[\\/][\w-]+\.json)$/, `ไฟล์แปลกปลอมใน cards/: ${f}`);

    const body = fs.readFileSync(full, "utf8");
    assert.ok(!/U[0-9a-f]{32}/.test(body), `มี LINE user id ใน ${f}`);
    assert.ok(!/Q-\d{8}-\d{3}/.test(body), `มี quote_id จริงใน ${f}`);
  }

  // ราคาต้องไม่ถูกพิมพ์ซ้ำลง template — ไม่งั้นจะมีแหล่งราคาที่สอง
  const tpl = JSON.stringify(loadTemplate("product-card"));
  for (const entry of loadPriceList().items) {
    assert.ok(!tpl.includes(String(entry.price)), `template มีราคา ${entry.price} ฝังอยู่`);
  }
});

test("keywords.json อ่านได้และมีคำครบทั้ง 3 กลุ่ม", () => {
  const k = loadKeywords();
  for (const group of ["cardIntent", "quoteIntent", "paymentMute"]) {
    assert.ok(Array.isArray(k[group]) && k[group].length > 0, `ขาดคีย์เวิร์ดกลุ่ม ${group}`);
  }
  for (const must of ["โอนแล้ว", "สลิป", "ชำระ", "จ่ายแล้ว"]) {
    assert.ok(k.paymentMute.includes(must), `ขาดคำสั่งเงียบ: ${must}`);
  }
});
