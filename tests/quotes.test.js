/*
 * เทสต์ Quote Engine — ทุกข้อในนี้เป็นเรื่องเงินจริงหรือข้อมูลลูกค้าจริง
 * ข้อที่ผิดแล้วเสียหายที่สุดคือ "บอทอนุมัติส่วนลดเกินเพดานให้ตัวเอง" กับ "ไฟล์ใบเสนอราคาอ่านได้ทั้งเครื่อง"
 *
 * ทุกเทสต์ชี้ที่เก็บไปโฟลเดอร์ชั่วคราว ไม่มีข้อไหนแตะ ~/shop-data ของจริง
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEPOSIT_PERCENT,
  DISCOUNT_CAP_PERCENT,
  HIGH_VALUE_BAHT,
  STATUS,
  VALID_DAYS,
  canIssueQr,
  canSendQuoteCard,
  createQuoteStore,
  defaultDir,
  reportLine,
} from "../src/quotes.js";

/* ไอดีปลอมที่จงใจใส่ตัวอักษรนอก hex ("test") เพื่อไม่ให้ไปชนด่านกวาด PII ใน tests/privacy.test.js
 * — ด่านนั้นต้องกวาดโฟลเดอร์ tests/ ด้วย ถึงจะกันไอดีจริงที่เผลอ paste มาจาก log ได้ */
const USER = "Utest00000000000000000000000abcd";
const CHAT = USER;

function freshStore(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quote-test-"));
  return createQuoteStore({ dir: path.join(root, "quotes"), ...opts });
}

const order = (slug, qty) => [{ slug, qty }];

test("ออกใบปกติ → ตรวจอัตโนมัติผ่าน ได้สถานะ ตรวจแล้ว และยอดตรง products.md", () => {
  const store = freshStore();
  const { quote, ok } = store.create({ lineUserId: USER, chatId: CHAT, requested: order("brownie-box", 2) });

  assert.equal(ok, true);
  assert.equal(quote.status, STATUS.REVIEWED);
  assert.equal(quote.items[0].unit_price, 189, "ราคาต่อหน่วยต้องมาจากตารางใน products.md");
  assert.equal(quote.subtotal, 378);
  assert.equal(quote.net, 378);
  assert.equal(quote.deposit, 189, `มัดจำ ${DEPOSIT_PERCENT}%`);
});

test("quote_id เป็น Q-YYYYMMDD-NNN และเดินเลขต่อกันไม่ชน", () => {
  const store = freshStore();
  const ids = Array.from({ length: 12 }, () => store.create({ lineUserId: USER, chatId: CHAT, requested: order("shio-pan", 1) }).quote.quote_id);

  const today = new Date();
  const day = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;

  assert.equal(new Set(ids).size, ids.length, "ห้ามมีเลขซ้ำ");
  assert.equal(ids[0], `Q-${day}-001`);
  assert.equal(ids[11], `Q-${day}-012`);
  for (const id of ids) assert.match(id, /^Q-\d{8}-\d{3}$/);
});

test("จองเลขแบบ atomic — ไฟล์ที่มีอยู่แล้วถูกข้ามไป ไม่เขียนทับของเดิม", () => {
  const store = freshStore();
  const first = store.create({ lineUserId: USER, chatId: CHAT, requested: order("shio-pan", 1) }).quote;

  /* จำลองใบที่ process อื่นเพิ่งจองเลขถัดไปไว้ */
  const day = first.quote_id.slice(2, 10);
  const squatted = path.join(store.dir, `Q-${day}-002.json`);
  fs.writeFileSync(squatted, "{}", { mode: 0o600 });

  const second = store.create({ lineUserId: USER, chatId: CHAT, requested: order("shio-pan", 1) }).quote;
  assert.equal(second.quote_id, `Q-${day}-003`, "ต้องข้ามเลขที่ถูกจองไปแล้ว");
  assert.equal(fs.readFileSync(squatted, "utf8"), "{}", "ห้ามเขียนทับไฟล์ของคนอื่น");
});

test("โฟลเดอร์ 700 · ไฟล์ 600 — user อื่นบนเครื่องอ่านไม่ได้", { skip: process.platform === "win32" }, () => {
  const store = freshStore();
  const { quote } = store.create({ lineUserId: USER, chatId: CHAT, requested: order("shio-pan", 1) });

  assert.equal(fs.statSync(store.dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(store.dir, `${quote.quote_id}.json`)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(store.dir, "index")).mode & 0o777, 0o700);
});

test("ที่เก็บของจริงอยู่นอก repo เสมอ", () => {
  const repo = path.resolve(import.meta.dirname, "..");
  assert.ok(!defaultDir().startsWith(repo + path.sep), `ที่เก็บต้องไม่อยู่ใน repo: ${defaultDir()}`);
  assert.match(defaultDir(), /shop-data[\\/]quotes$/);
});

test("record มีครบทุกฟิลด์ที่โจทย์กำหนด", () => {
  const store = freshStore();
  const { quote } = store.create({ lineUserId: USER, chatId: CHAT, requested: order("brownie-box", 2) });

  for (const field of [
    "quote_id", "line_user_id", "conversation_suffix", "items", "discount_percent",
    "net", "deposit", "created_at", "expires_at", "status", "approver", "audit",
  ]) {
    assert.ok(field in quote, `ขาดฟิลด์ ${field}`);
  }
  for (const field of ["slug", "name", "qty", "unit_price", "line_total"]) {
    assert.ok(field in quote.items[0], `รายการขาดฟิลด์ ${field}`);
  }

  assert.equal(quote.line_user_id, USER, "ต้องย้อนจากยอดกลับไปหาลูกค้าคนนั้นได้");
  assert.equal(quote.conversation_suffix, CHAT.slice(-4));
  assert.equal(quote.conversation_suffix.length, 4);
});

test(`อายุใบเสนอราคา ${VALID_DAYS} วัน`, () => {
  const store = freshStore();
  const { quote } = store.create({ lineUserId: USER, chatId: CHAT, requested: order("shio-pan", 1) });
  const days = (new Date(quote.expires_at) - new Date(quote.created_at)) / 86_400_000;
  assert.equal(days, VALID_DAYS);
});

test("mapping ลูกค้า ↔ ใบเสนอราคา ย้อนกลับได้ทุกใบ", () => {
  const store = freshStore();
  const a = store.create({ lineUserId: USER, chatId: CHAT, requested: order("shio-pan", 1) }).quote;
  const b = store.create({ lineUserId: USER, chatId: CHAT, requested: order("brownie-box", 1) }).quote;
  store.create({ lineUserId: "Uคนอื่น", chatId: "Uคนอื่น", requested: order("shio-pan", 1) });

  const mine = store.byUser(USER).map((q) => q.quote_id);
  assert.deepEqual(mine.sort(), [a.quote_id, b.quote_id].sort());
  assert.equal(store.byUser("Uไม่เคยซื้อ").length, 0);
});

test("หน้ารายงานโชว์แค่ suffix 4 ตัว ไม่มี LINE user id เต็ม", () => {
  const store = freshStore();
  const { quote } = store.create({ lineUserId: USER, chatId: CHAT, requested: order("brownie-box", 1) });

  const line = reportLine(quote);
  assert.ok(!line.includes(USER), "รายงานห้ามมี LINE user id เต็ม");
  assert.match(line, new RegExp(`…${CHAT.slice(-4)}`));
  assert.match(line, /Q-\d{8}-\d{3}/);
});

test(`ส่วนลดเกินเพดาน ${DISCOUNT_CAP_PERCENT}% → คง draft และบอกเหตุผล`, () => {
  const store = freshStore();

  const ok = store.create({ lineUserId: USER, chatId: CHAT, requested: order("brownie-box", 1), discountPercent: DISCOUNT_CAP_PERCENT });
  assert.equal(ok.quote.status, STATUS.REVIEWED, "ลดเท่าเพดานพอดียังผ่านเอง");

  const over = store.create({ lineUserId: USER, chatId: CHAT, requested: order("brownie-box", 1), discountPercent: DISCOUNT_CAP_PERCENT + 1 });
  assert.equal(over.ok, false);
  assert.equal(over.quote.status, STATUS.DRAFT, "เกินเพดานห้ามเลื่อนสถานะเอง");
  assert.match(over.reasons.join(" "), /เกินเพดาน/);
});

test(`ยอดเกิน ${HIGH_VALUE_BAHT.toLocaleString()} บาท → คง draft รอเจ้าของร้าน`, () => {
  const store = freshStore();
  /* 189 × 400 = 75,600 บาท */
  const big = store.create({ lineUserId: USER, chatId: CHAT, requested: order("brownie-box", 400) });

  assert.equal(big.ok, false);
  assert.equal(big.quote.status, STATUS.DRAFT);
  assert.equal(big.quote.net, 75_600, "ยอดยังต้องคิดให้ถูกต้อง แค่ไม่เลื่อนสถานะ");
  assert.match(big.reasons.join(" "), /เกินเกณฑ์/);
});

test("draft ห้ามส่งการ์ดใบเสนอราคา และห้ามออก QR", () => {
  const store = freshStore();
  const { quote } = store.create({ lineUserId: USER, chatId: CHAT, requested: order("brownie-box", 400) });

  assert.equal(quote.status, STATUS.DRAFT);
  assert.equal(canSendQuoteCard(quote), false);
  assert.equal(canIssueQr(quote), false);
});

test("อนุมัติโดยเจ้าของร้าน → ตรวจแล้ว พร้อม approver และเหตุผลที่ข้ามใน audit", () => {
  const store = freshStore();
  const { quote } = store.create({ lineUserId: USER, chatId: CHAT, requested: order("brownie-box", 1), discountPercent: 30 });
  assert.equal(quote.status, STATUS.DRAFT);

  const res = store.approve(quote.quote_id, "Uเจ้าของร้าน");
  assert.equal(res.ok, true);
  assert.equal(res.quote.status, STATUS.REVIEWED);
  assert.equal(res.quote.approver, "Uเจ้าของร้าน");

  const approval = res.quote.audit.find((a) => a.action === "approve");
  assert.ok(approval, "ต้องมี audit ของการอนุมัติ");
  assert.equal(approval.actor, "Uเจ้าของร้าน");
  assert.ok(approval.at, "ต้องบันทึกเวลาด้วย");
  assert.match(approval.override.join(" "), /เกินเพดาน/, "ต้องรู้ว่าอนุมัติข้ามข้อไหนไป");

  assert.equal(canIssueQr(store.get(quote.quote_id)), true, "อนุมัติแล้วออก QR ได้");
});

test("อนุมัติซ้ำ / อนุมัติใบที่ไม่มีอยู่ → ไม่มีผล", () => {
  const store = freshStore();
  const { quote } = store.create({ lineUserId: USER, chatId: CHAT, requested: order("brownie-box", 400) });

  assert.equal(store.approve(quote.quote_id, "owner").ok, true);
  assert.equal(store.approve(quote.quote_id, "owner").ok, false, "อนุมัติซ้ำไม่ได้");
  assert.equal(store.approve("Q-20990101-999", "owner").ok, false);
});

test("ปฏิเสธ → ยกเลิก และบันทึกคนสั่ง", () => {
  const store = freshStore();
  const { quote } = store.create({ lineUserId: USER, chatId: CHAT, requested: order("brownie-box", 400) });

  const res = store.reject(quote.quote_id, "Uเจ้าของร้าน", "ทำไม่ทัน");
  assert.equal(res.quote.status, STATUS.CANCELLED);
  assert.equal(res.quote.approver, "Uเจ้าของร้าน");
  assert.equal(canSendQuoteCard(res.quote), false);
  assert.equal(canIssueQr(res.quote), false);
  assert.equal(store.reject(quote.quote_id, "owner").ok, false, "ใบที่จบแล้วเปลี่ยนอีกไม่ได้");
});

test("เส้นทางสถานะเดินได้ทางเดียว ข้ามขั้นไม่ได้ ถอยหลังไม่ได้", () => {
  const store = freshStore();
  const { quote } = store.create({ lineUserId: USER, chatId: CHAT, requested: order("brownie-box", 1) });
  const id = quote.quote_id;

  assert.equal(store.advance(id, STATUS.PAID).ok, false, "ตรวจแล้ว → ยืนยันชำระแล้ว ข้ามขั้นไม่ได้");
  assert.equal(store.advance(id, STATUS.SENT).ok, true);
  assert.equal(store.advance(id, STATUS.REVIEWED).ok, false, "ถอยหลังไม่ได้");
  assert.equal(store.advance(id, STATUS.SLIP).ok, true);
  assert.equal(store.advance(id, STATUS.PAID).ok, true);
  assert.equal(store.advance(id, STATUS.SENT).ok, false, "ใบที่ชำระแล้วเปลี่ยนอีกไม่ได้");

  const trail = store.get(id).audit.filter((a) => a.action === "status").map((a) => a.to);
  assert.deepEqual(trail, [STATUS.REVIEWED, STATUS.SENT, STATUS.SLIP, STATUS.PAID]);
});

test("เลยวันหมดอายุ → กลายเป็น หมดอายุ อัตโนมัติ และห้ามออก QR", () => {
  let clock = new Date("2026-09-16T10:00:00.000Z");
  const store = freshStore({ now: () => clock });

  const { quote } = store.create({ lineUserId: USER, chatId: CHAT, requested: order("brownie-box", 1) });
  store.advance(quote.quote_id, STATUS.SENT);
  assert.equal(canIssueQr(store.get(quote.quote_id)), true);

  clock = new Date("2026-09-23T10:00:01.000Z"); // เลย 7 วันไป 1 วินาที
  const expired = store.get(quote.quote_id);

  assert.equal(expired.status, STATUS.EXPIRED);
  assert.equal(canIssueQr(expired), false, "ใบหมดอายุห้ามออก QR เด็ดขาด");
  assert.equal(canSendQuoteCard(expired), false);
  assert.match(expired.audit.at(-1).note, /หมดอายุ/);

  /* เปลี่ยนแล้วต้องติดอยู่บนดิสก์จริง ไม่ใช่เปลี่ยนแค่ในหน่วยความจำรอบนี้ */
  const onDisk = JSON.parse(fs.readFileSync(path.join(store.dir, `${quote.quote_id}.json`), "utf8"));
  assert.equal(onDisk.status, STATUS.EXPIRED);
});

test("ใบที่ชำระแล้วไม่ถูกเปลี่ยนเป็นหมดอายุย้อนหลัง", () => {
  let clock = new Date("2026-09-16T10:00:00.000Z");
  const store = freshStore({ now: () => clock });
  const { quote } = store.create({ lineUserId: USER, chatId: CHAT, requested: order("brownie-box", 1) });

  store.advance(quote.quote_id, STATUS.SENT);
  store.advance(quote.quote_id, STATUS.SLIP);
  store.advance(quote.quote_id, STATUS.PAID);

  clock = new Date("2026-10-30T10:00:00.000Z");
  assert.equal(store.get(quote.quote_id).status, STATUS.PAID);
});

test("ของที่ไม่มีใน products.md → ไม่ออกเลขใบให้เลย ส่งต่อคน", () => {
  const store = freshStore();
  const res = store.create({ lineUserId: USER, chatId: CHAT, requested: [{ slug: "croissant", qty: 2, name: "ครัวซองต์" }] });

  assert.equal(res.quote, null, "ห้ามเผาเลขใบให้ของที่ไม่มีราคา");
  assert.match(res.reasons.join(" "), /products\.md ไม่ครบ/);
  assert.equal(store.list().length, 0);
});

test("ราคาใน products.md ไม่ครบ (ยังไม่ระบุ) → ส่งต่อคน", () => {
  const store = freshStore({
    source: () => ({ ok: true, checksum: "x", items: [{ slug: "shio-pan", name: "ขนมปังชิโอะปัง", unit: "ชิ้น", price: 15, satang: 1500 }] }),
  });
  const res = store.create({ lineUserId: USER, chatId: CHAT, requested: [{ slug: "brownie-box", qty: 1, name: "บราวนี่ (กล่อง 6 ชิ้น)" }] });

  assert.equal(res.quote, null);
  assert.match(res.reasons.join(" "), /products\.md ไม่ครบ/);
});

test("คิดยอดใหม่จาก source เสมอ — ใบที่ถูกแก้ตัวเลขด้วยมือตรวจไม่ผ่าน", () => {
  const store = freshStore();
  const { quote } = store.create({ lineUserId: USER, chatId: CHAT, requested: order("brownie-box", 2) });

  /* จำลองคนเข้าไปแก้ยอดในไฟล์เอง */
  const tampered = { ...quote, net: 1, deposit: 0.5 };
  const verdict = store.review(tampered);

  assert.equal(verdict.ok, false);
  assert.match(verdict.reasons.join(" "), /ไม่ตรงกับที่คำนวณใหม่/);
});

test("แก้ใบที่ส่งลูกค้าแล้ว → ขึ้น version ใหม่ เก็บของเดิมไว้ ไม่ทับ", () => {
  const store = freshStore();
  const { quote } = store.create({ lineUserId: USER, chatId: CHAT, requested: order("brownie-box", 2) });
  store.advance(quote.quote_id, STATUS.SENT);

  const res = store.revise(quote.quote_id, { requested: order("brownie-box", 3), reason: "ลูกค้าขอเพิ่ม 1 กล่อง" });

  assert.equal(res.quote.version, 2);
  assert.equal(res.quote.net, 567);
  assert.equal(res.quote.previous_versions.length, 1);
  assert.equal(res.quote.previous_versions[0].net, 378, "ยอดที่ลูกค้าเคยเห็นต้องยังย้อนดูได้");
  assert.equal(res.quote.previous_versions[0].status, STATUS.SENT);
  assert.ok(res.quote.audit.some((a) => a.action === "revise"), "ต้องมี audit ของการแก้");
});

test("ฉบับแก้ไขที่เกินเพดาน ต้องกลับไปรอเจ้าของร้านใหม่ ไม่ใช่ส่งต่อได้เลย", () => {
  const store = freshStore();
  const { quote } = store.create({ lineUserId: USER, chatId: CHAT, requested: order("brownie-box", 2) });
  store.advance(quote.quote_id, STATUS.SENT);

  const res = store.revise(quote.quote_id, { discountPercent: 40, reason: "ลูกค้าต่อราคา" });

  assert.equal(res.ok, false);
  assert.equal(res.quote.status, STATUS.DRAFT);
  assert.equal(res.quote.approver, null, "ของเดิมเคยอนุมัติไว้ ต้องไม่ติดมากับฉบับใหม่");
  assert.equal(canIssueQr(res.quote), false);
});

test("audit trail เรียงตามเวลาและบอกได้ว่าใครทำอะไร", () => {
  const store = freshStore();
  const { quote } = store.create({ lineUserId: USER, chatId: CHAT, requested: order("brownie-box", 400) });
  store.approve(quote.quote_id, "Uเจ้าของร้าน");
  store.advance(quote.quote_id, STATUS.SENT, { actor: "bot" });

  const audit = store.get(quote.quote_id).audit;
  assert.deepEqual(audit.map((a) => a.action), ["create", "review-failed", "approve", "status", "status"]);

  const times = audit.map((a) => new Date(a.at).getTime());
  assert.deepEqual([...times].sort((a, b) => a - b), times, "audit ต้องเรียงตามเวลา");
  for (const a of audit) assert.ok(a.actor, "ทุกรายการต้องรู้ว่าใครทำ");
});

test("ไฟล์บนดิสก์เก็บ mapping และ audit ครบ — เปิดอ่านย้อนหลังได้จริง", () => {
  const store = freshStore();
  const { quote } = store.create({ lineUserId: USER, chatId: CHAT, requested: order("brownie-box", 1) });

  const onDisk = JSON.parse(fs.readFileSync(path.join(store.dir, `${quote.quote_id}.json`), "utf8"));
  assert.equal(onDisk.line_user_id, USER);
  assert.ok(onDisk.audit.length > 0);
  assert.equal(onDisk.price_source, "products.md");
  assert.ok(onDisk.price_source_checksum, "ต้องรู้ว่าใบนี้ออกตอนตารางราคาหน้าตาแบบไหน");
});
