/*
 * เทสต์ความเป็นส่วนตัวของ repo — repo นี้เป็น public
 *
 * ข้อนี้ป้องกันความผิดพลาดที่ "ย้อนกลับไม่ได้": ข้อมูลลูกค้าที่ commit ขึ้น GitHub แล้ว
 * อยู่ใน history ตลอดไป ต่อให้ลบไฟล์ทีหลังก็ยังขุดกลับมาได้
 * กวาดทุกไฟล์ที่ track อยู่ ไม่ใช่เฉพาะไฟล์ที่เพิ่งแก้
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { BRAIN_FILES } from "../src/brain.js";
import { paymentDestinations } from "../src/payment.js";
import { defaultDir } from "../src/quotes.js";

const ROOT = path.resolve(import.meta.dirname, "..");

/*
 * ไฟล์ที่ commit ไปแล้ว "บวก" ไฟล์ใหม่ที่ยังไม่ได้ add แต่ไม่ได้อยู่ใน .gitignore
 * ต้องกวาดของที่ยังไม่ commit ด้วย ไม่งั้นเทสต์จะเขียวจนถึงวินาทีที่ commit แล้วสายเกินแก้
 */
const trackedFiles = () =>
  execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    /* ไฟล์รูปเป็น binary ไม่ต้องกวาดข้อความ และไฟล์เทสต์ชุดนี้เองย่อมมีรูปแบบพวกนี้อยู่ */
    .filter((f) => !/\.(jpe?g|png|ico|pdf)$/i.test(f));

/* LINE user id ของจริง: U ตามด้วย hex 32 ตัว */
const LINE_USER_ID = /\bU[0-9a-f]{32}\b/;

test("ไม่มี LINE user id ของจริงในไฟล์ที่ track อยู่", () => {
  const offenders = [];

  for (const file of trackedFiles()) {
    const body = fs.readFileSync(path.join(ROOT, file), "utf8");
    if (LINE_USER_ID.test(body)) offenders.push(`${file}: ${body.match(LINE_USER_ID)[0]}`);
  }

  assert.deepEqual(offenders, [], `พบ LINE user id ใน repo:\n${offenders.join("\n")}`);
});

test("ไม่มีไฟล์ใบเสนอราคาจริงหลุดเข้า repo", () => {
  const offenders = trackedFiles().filter((f) => /Q-\d{8}-\d{3}\.json$/.test(path.basename(f)));
  assert.deepEqual(offenders, [], `ใบเสนอราคาต้องอยู่บน VPS เท่านั้น: ${offenders.join(", ")}`);

  /* และต้องไม่มีโฟลเดอร์ shop-data โผล่ใน repo ไม่ว่าจะ track หรือไม่ */
  assert.equal(fs.existsSync(path.join(ROOT, "shop-data")), false);
});

test(".gitignore กัน shop-data ไว้แล้ว เผื่อมีคนตั้ง SHOP_DATA_DIR ชี้มาที่ repo", () => {
  const ignore = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8");
  assert.match(ignore, /shop-data/);
});

test("ที่เก็บใบเสนอราคาเริ่มต้นอยู่นอก repo", () => {
  assert.ok(!defaultDir().startsWith(ROOT + path.sep), `ต้องไม่อยู่ใน repo: ${defaultDir()}`);
});

test("cards/ ไม่มีข้อมูลลูกค้าหรือธุรกรรมจริง", () => {
  for (const file of trackedFiles().filter((f) => f.startsWith("cards/"))) {
    const body = fs.readFileSync(path.join(ROOT, file), "utf8");
    assert.ok(!LINE_USER_ID.test(body), `${file} มี LINE user id`);
    assert.ok(!/Q-\d{8}-\d{3}/.test(body), `${file} มี quote_id จริง`);
    assert.ok(!/0\d{1,2}-?\d{3}-?\d{4}/.test(body), `${file} มีเบอร์โทร`);
  }
});

test("ข้อความรายงานที่ส่งออกไม่มี LINE user id เต็ม (มีแต่ suffix 4 ตัว)", async () => {
  const { reportLine } = await import("../src/quotes.js");
  /* ประกอบตอนรัน ไม่เขียนเป็นข้อความตรง ๆ ในไฟล์ ไม่งั้นด่านกวาดข้างบนจะจับไฟล์ตัวเอง */
  const fullId = `U${"a1b2c3d4".repeat(3)}e5f6a7b8`;

  const line = reportLine({
    quote_id: "Q-20260916-001",
    status: "draft",
    version: 1,
    conversation_suffix: fullId.slice(-4),
    items: [{ name: "บราวนี่ (กล่อง 6 ชิ้น)", qty: 1 }],
    net: 189,
    deposit: 94.5,
  });

  assert.ok(!line.includes(fullId));
  assert.ok(!LINE_USER_ID.test(line));
  assert.match(line, /…a7b8/);
});

/*
 * ═══ เลขบัญชีต้องมาจาก ENV ทางเดียว ═══
 *
 * สมองร้านเอา context.md · products.md · promotions.md ไปเป็น system prompt ทั้งไฟล์
 * ถ้าเลขพร้อมเพย์หรือเลขบัญชีไปนั่งอยู่ในไฟล์พวกนี้ สมองร้านจะพิมพ์ตอบลูกค้าได้เอง
 * ซึ่งเท่ากับมีแหล่งเลขบัญชีที่สองที่ "แก้ได้ด้วยการแก้ข้อความ" — และเงินที่โอนผิดบัญชีเอาคืนไม่ได้
 *
 * ด่านนี้จึงกวาดไฟล์ที่สมองร้านอ่าน หาอะไรที่หน้าตาเหมือนเลขบัญชี/เบอร์พร้อมเพย์
 */
test("ไฟล์ที่สมองร้านอ่าน ต้องไม่มีเลขพร้อมเพย์หรือเลขบัญชี", () => {
  /* เบอร์มือถือไทย · เลขบัญชีธนาคาร · เลขบัตรประชาชน 13 หลัก */
  const patterns = [/\b0\d{1,2}-?\d{3}-?\d{4}\b/, /\b\d{3}-\d-\d{4,5}-\d\b/, /\b\d{13}\b/];
  const offenders = [];

  for (const file of BRAIN_FILES) {
    const body = fs.readFileSync(path.join(ROOT, file), "utf8");
    for (const re of patterns) {
      const hit = body.match(re);
      if (hit) offenders.push(`${file}: ${hit[0]}`);
    }
  }

  assert.deepEqual(offenders, [], `เลขบัญชีต้องอยู่ใน ENV เท่านั้น:\n${offenders.join("\n")}`);
});

test("ไม่ได้ตั้ง ENV = ไม่มีช่องทางรับเงิน — ไม่มีเลขสำรองฝังในโค้ด", () => {
  /* กันวันที่มีคนใส่ค่าเริ่มต้น "เผื่อไว้ก่อน" ลงไปในโค้ด ซึ่งจะกลายเป็นบัญชีที่ไม่มีใครตั้งใจใช้ */
  assert.deepEqual(paymentDestinations({ env: {} }), []);
});
