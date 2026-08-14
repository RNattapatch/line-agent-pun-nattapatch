/*
 * เทสต์ตรรกะการตอบ — รันด้วย `npm test` (node:test ที่มากับ Node ไม่ต้องลง framework)
 *
 * ที่เทสต์หนักเป็นพิเศษคือ "กติกาที่ห้ามละเมิด" ใน context.md ข้อ 6
 * เพราะเป็นข้อที่ผิดแล้วลูกค้าเห็นทันที และเป็นข้อที่คนแก้โค้ดทีหลังเผลอทำหลุดได้ง่ายที่สุด
 */

import assert from "node:assert/strict";
import test from "node:test";

import { NO_IMAGE_REPLY, buildReply } from "../src/reply.js";
import { PRODUCTS } from "../src/products.js";

const BASE = "https://shop.example.com";

/* แคชปลอมที่ "มีรูปครบ" — ชี้ไปที่ไฟล์จริงใน public/images ที่ npm run gen:images สร้างไว้ */
const fullCache = {
  products: Object.fromEntries(
    PRODUCTS.map((p) => [p.slug, { name: p.name, path: `/images/${p.slug}.jpg` }]),
  ),
  staff: { name: "พนักงานประจำร้าน (น้องแมว 2 ตัว)", path: "/images/staff.jpg" },
};

/* แคชว่าง = ยังไม่เคยรัน gen:images หรือ kie.ai ล่มตอน gen */
const emptyCache = { products: {} };

const say = (text, cache = fullCache, baseUrl = BASE) => buildReply(text, { baseUrl, cache });
const texts = (r) => r.messages.filter((m) => m.type === "text").map((m) => m.text);

test("ขอรูปสินค้าที่มีในระบบ → ส่งรูปจริงพร้อมราคา", () => {
  const r = say("ขอดูรูปชิโอะปังหน่อยค่ะ");

  const image = r.messages.find((m) => m.type === "image");
  assert.ok(image, "ต้องมี message ชนิด image");
  assert.equal(image.originalContentUrl, `${BASE}/images/shio-pan.jpg`);
  assert.equal(image.previewImageUrl, `${BASE}/images/shio-pan.jpg`, "LINE บังคับให้มี previewImageUrl ด้วย");
  assert.ok(image.originalContentUrl.startsWith("https://"), "LINE รับเฉพาะ HTTPS");
  assert.match(texts(r).join(" "), /15 บาท/, "ราคาต้องตรงกับ products.md");
  assert.equal(r.escalate, null, "สินค้าที่มีรูปแล้วไม่ต้องรบกวนแอดมิน");
});

test("แต่ละสินค้าในรายการหยิบรูปของตัวเองได้ถูกใบ", () => {
  const cases = [
    ["ขอรูป Box Set 1", "box-set-1"],
    ["ขอดูรูปบราวนี่ชิ้น", "brownie-piece"],
    ["ขอรูปบราวนี่กล่อง 6 ชิ้น", "brownie-box"],
  ];

  for (const [text, slug] of cases) {
    const image = say(text).messages.find((m) => m.type === "image");
    assert.ok(image, `"${text}" ควรได้รูป`);
    assert.equal(image.originalContentUrl, `${BASE}/images/${slug}.jpg`);
  }
});

test("ขอรูปของที่ไม่มีในรายการ → ข้อความสำรองเป๊ะ ๆ + ส่งต่อแอดมิน", () => {
  for (const text of ["ขอดูรูปครัวซองต์หน่อย", "มีรูปเค้กกล้วยหอมไหมคะ", "ขอรูปโดนัทค่ะ"]) {
    const r = say(text);
    assert.deepEqual(texts(r), [NO_IMAGE_REPLY], `"${text}" ต้องตอบข้อความสำรองอย่างเดียว`);
    assert.ok(!r.messages.some((m) => m.type === "image"), "ห้ามส่งรูปของนอกรายการ");
    assert.ok(r.escalate, "ต้องส่งต่อแอดมิน");
  }
});

test("kie.ai ล่ม / ยังไม่ได้ gen รูป → ลูกค้าได้ข้อความสำรอง ไม่ใช่ error", () => {
  const r = say("ขอดูรูปชิโอะปังหน่อย", emptyCache);

  assert.deepEqual(texts(r), [NO_IMAGE_REPLY]);
  assert.ok(!r.messages.some((m) => m.type === "image"), "ไม่มีรูปก็ต้องไม่ส่ง URL ที่โหลดไม่ขึ้น");
  assert.ok(r.escalate, "ต้องส่งต่อแอดมินให้ตามรูปมาส่งลูกค้า");
});

test("ไฟล์รูปหายจากดิสก์ทั้งที่มีในแคช → ยังต้องตกไปที่ข้อความสำรอง", () => {
  const brokenCache = { products: { "shio-pan": { name: "ขนมปังชิโอะปัง", path: "/images/ไม่มีไฟล์นี้.jpg" } } };
  const r = say("ขอรูปชิโอะปัง", brokenCache);

  assert.deepEqual(texts(r), [NO_IMAGE_REPLY]);
  assert.ok(!r.messages.some((m) => m.type === "image"));
});

test("PUBLIC_BASE_URL ไม่ใช่ https → ไม่ส่งรูป (LINE บังคับ TLS)", () => {
  for (const baseUrl of ["http://shop.example.com", "shop.example.com", "", undefined]) {
    // เรียก buildReply ตรง ๆ ไม่ผ่าน say() เพราะ helper มีค่า default ที่จะบังค่า undefined ทิ้ง
    const r = buildReply("ขอรูปชิโอะปัง", { baseUrl, cache: fullCache });
    assert.deepEqual(texts(r), [NO_IMAGE_REPLY], `baseUrl "${baseUrl}" ต้องไม่ส่งรูป`);
    assert.ok(!r.messages.some((m) => m.type === "image"));
  }
});

test('ลูกค้าพูดว่า "บราวนี่" เฉย ๆ → ถามกลับ ไม่เดาให้', () => {
  const r = say("ขอดูรูปบราวนี่หน่อยค่ะ");

  assert.ok(!r.messages.some((m) => m.type === "image"), "กำกวมอยู่ ห้ามเดาส่งรูปไปก่อน");
  const reply = texts(r).join(" ");
  assert.match(reply, /39/);
  assert.match(reply, /189/);
  assert.match(reply, /แบบไหน/);
});

test("ขอดูรูปแบบไม่ระบุสินค้า → ยื่นรายการให้เลือก", () => {
  /*
   * "ขอดูรูปขนมปังของร้านครับ" เคยตกไปทาง "ของนอกรายการ" แล้วไปปลุกแอดมินฟรี ๆ
   * ทั้งที่ลูกค้าแค่ถามกว้าง ๆ — เจอจาก log ของจริงบน VPS
   */
  for (const q of [
    "ขอดูรูปหน่อยค่ะ",
    "ขอดูรูปขนมปังของร้านครับ",
    "มีรูปสินค้าอะไรบ้างคะ",
    "ขอดูรูปขนมทั้งหมดหน่อย",
  ]) {
    const r = say(q);
    const reply = texts(r).join(" ");
    for (const p of PRODUCTS) {
      assert.match(reply, new RegExp(p.name.replace(/[()]/g, "\\$&")), `"${q}" ควรยื่นรายการทั้งหมด`);
    }
    assert.equal(r.escalate, null, `"${q}" ไม่ควรรบกวนแอดมิน`);
  }
});

test("ขอดูรูปพนักงาน → ส่งรูปน้องแมวประจำร้าน ไม่ต้องรบกวนแอดมิน", () => {
  for (const text of ["ขอดูรูปพนักงานหน่อยค่ะ", "มีรูปพนักงานไหมคะ", "ขอดูพนักงานประจำร้านหน่อย", "staff หน้าตายังไง"]) {
    const r = say(text);

    const image = r.messages.find((m) => m.type === "image");
    assert.ok(image, `"${text}" ควรได้รูปพนักงาน`);
    assert.equal(image.originalContentUrl, `${BASE}/images/staff.jpg`);
    assert.equal(image.previewImageUrl, `${BASE}/images/staff.jpg`);
    assert.match(texts(r).join(" "), /พนักงาน/);
    assert.equal(r.escalate, null, "มีรูปพนักงานในระบบแล้ว ไม่ต้องส่งต่อแอดมิน");
  }
});

test("ขอดูรูปพนักงานแต่รูปไม่อยู่ในแคช → ตอบสุภาพ + ส่งต่อแอดมิน ไม่มีศัพท์เทคนิค", () => {
  const r = say("ขอดูรูปพนักงานหน่อยค่ะ", emptyCache);

  assert.ok(!r.messages.some((m) => m.type === "image"), "ไม่มีรูปก็ต้องไม่ส่ง URL ที่โหลดไม่ขึ้น");
  assert.match(texts(r).join(" "), /แอดมิน/);
  assert.ok(r.escalate, "ต้องส่งต่อแอดมินให้ส่งรูปแทน");
});

test('ถามว่า "ของจริงหน้าตาแบบนี้ไหม" → ไม่ยืนยัน ส่งต่อแอดมินขอรูปจริง', () => {
  for (const text of ["ของจริงหน้าตาแบบนี้ไหมคะ", "รูปนี้ตรงปกไหม", "ของจริงเหมือนรูปหรือเปล่า"]) {
    const r = say(text);
    const reply = texts(r).join(" ");

    assert.ok(!r.messages.some((m) => m.type === "image"), "ห้ามส่งรูปประกอบไปยืนยันแทนของจริง");
    assert.ok(!/ใช่|เหมือนกัน|ตรงปก(ค่ะ|เลย)/.test(reply), `ห้ามยืนยัน: "${reply}"`);
    assert.match(reply, /แอดมิน/);
    assert.ok(r.escalate);
  }
});

/*
 * ด่านกวาดรวม: ยิงทุกประโยคที่นึกออกเข้าไป แล้วเช็คว่าไม่มีคำต้องห้ามหลุดออกมาเลย
 * เพิ่มเคสใหม่ในลิสต์นี้ได้เรื่อย ๆ เวลาเจอประโยคแปลก ๆ จากลูกค้าจริง
 */
const ALL_INPUTS = [
  "สวัสดีค่ะ",
  "เมนู",
  "ขอดูรูปชิโอะปัง",
  "ขอรูป Box Set 1",
  "ขอดูรูปบราวนี่",
  "ขอรูปบราวนี่กล่อง",
  "ขอดูรูปหน่อย",
  "ขอดูรูปพนักงานหน่อย",
  "ขอรูปครัวซองต์",
  "ของจริงหน้าตาแบบนี้ไหม",
  "ราคาเท่าไหร่",
  "ส่งฟรีไหม",
  "",
];

test("ทุกคำตอบลงท้ายด้วย คะ/ค่ะ (context.md ข้อ 2)", () => {
  for (const input of ALL_INPUTS) {
    for (const cache of [fullCache, emptyCache]) {
      for (const line of texts(buildReply(input, { baseUrl: BASE, cache }))) {
        const lastLine = line.trim().split("\n").at(-1);
        assert.match(lastLine, /(คะ|ค่ะ)$/, `ลงท้ายไม่ถูก: "${lastLine}"`);
      }
    }
  }
});

test("ไม่มีคำต้องห้ามหลุดไปหาลูกค้า (context.md ข้อ 6)", () => {
  // AI / บอท / โมเดล / สร้างรูปไม่ได้ / ศัพท์เทคนิค — ห้ามโผล่ในข้อความถึงลูกค้าทุกกรณี
  const banned = [
    /\bAI\b/i,
    /บอท/,
    /โมเดล/,
    /สร้างรูป(ภาพ)?ไม่ได้/,
    /generate|kie\.ai|api|error|cache|แคช|url|http/i,
    /*
     * เคยหลุดจริงมาแล้ว: บอทตอบว่า "รูปพนักงานอยู่ที่นี่ค่ะ: /images/staff.jpg"
     * ลูกค้าขอดูรูป ต้องได้เห็นรูป ไม่ใช่ได้ path ที่กดไม่ได้ — path ต้องอยู่ในช่อง
     * originalContentUrl ของ message ชนิด image เท่านั้น ห้ามโผล่ในเนื้อข้อความ
     */
    /\/images\//,
    /\.(jpe?g|png)\b/i,
  ];

  for (const input of ALL_INPUTS) {
    for (const cache of [fullCache, emptyCache]) {
      for (const line of texts(buildReply(input, { baseUrl: BASE, cache }))) {
        for (const pattern of banned) {
          assert.ok(!pattern.test(line), `คำต้องห้าม ${pattern} โผล่ใน: "${line}"`);
        }
      }
    }
  }
});

test("ไม่มี input ไหนทำให้ระเบิด และตอบเสมอ", () => {
  for (const input of [...ALL_INPUTS, null, undefined, "   ", "🍞".repeat(500)]) {
    const r = buildReply(input, { baseUrl: BASE, cache: fullCache });
    assert.ok(r.messages.length > 0, `ต้องมีคำตอบเสมอ: ${input}`);
    assert.ok(r.messages.length <= 5, "LINE ส่งได้สูงสุด 5 ข้อความต่อ 1 reply");
  }
});
