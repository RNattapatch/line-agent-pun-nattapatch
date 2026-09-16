/*
 * เทสต์ Admin lane + ท่อใบเสนอราคาในแชท
 *
 * ข้อที่ห้ามพลาดที่สุด: คำสั่ง "อนุมัติใบเสนอ <quote_id>" ที่พิมพ์จากห้องลูกค้า
 * ต้องไม่มีผลเลย — ไม่งั้นลูกค้าอนุมัติส่วนลดเกินเพดานให้ตัวเองได้
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { NOT_ADMIN_REPLY, isAdminLane, parseCommand, runCommand } from "../src/admin.js";
import { STATUS, canIssueQr, createQuoteStore } from "../src/quotes.js";
import { CONFIRM_RE, handleConfirm, handleQuoteRequest, handleSlip } from "../src/quote-flow.js";
import { parseQuoteRequest } from "../src/quote-intent.js";

/* ช่องทางรับเงินสมมติ — ระบบอ่านจาก ENV เท่านั้น (src/payment.js) */
process.env.PAYMENT_ACCOUNT_NAME = "ร้านขนมปังสดสดสด (ทดสอบ)";
process.env.PAYMENT_DESTINATIONS_JSON = JSON.stringify([
  { id: "pp", type: "promptpay", label: "พร้อมเพย์", number: "099-999-9999" },
]);

const ADMIN = "Uแอดมิน00000000000000000000000000";
const CUSTOMER = "Uลูกค้า0000000000000000000000abcd";

const freshStore = (opts = {}) =>
  createQuoteStore({ dir: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "admin-test-")), "quotes"), ...opts });

const overCap = (store, chatId = CUSTOMER) =>
  store.create({ lineUserId: chatId, chatId, requested: [{ slug: "brownie-box", qty: 1 }], discountPercent: 30 }).quote;

const customerEvent = { source: { type: "user", userId: CUSTOMER } };
const adminEvent = { source: { type: "user", userId: ADMIN } };

test("แกะคำสั่งแอดมินได้ถูกต้อง", () => {
  assert.deepEqual(parseCommand("อนุมัติใบเสนอ Q-20260916-001"), { name: "approve", quoteId: "Q-20260916-001" });
  assert.deepEqual(parseCommand("ปฏิเสธใบเสนอ Q-20260916-002"), { name: "reject", quoteId: "Q-20260916-002" });
  assert.equal(parseCommand("อนุมัติใบเสนอ"), null, "ไม่มีเลขใบ = ไม่ใช่คำสั่ง");
  assert.equal(parseCommand("ขอใบเสนอราคาบราวนี่"), null, "คำขอของลูกค้าต้องไม่ถูกอ่านเป็นคำสั่ง");
  assert.equal(parseCommand("อนุมัติใบเสนอ Q-2026-1"), null, "รูปแบบเลขใบผิด = ไม่ใช่คำสั่ง");
});

test("admin lane = แชท 1:1 กับ ADMIN_USER_ID เท่านั้น", () => {
  assert.equal(isAdminLane(adminEvent, { adminUserId: ADMIN }), true);
  assert.equal(isAdminLane(customerEvent, { adminUserId: ADMIN }), false);

  /* แอดมินพิมพ์ในกลุ่มที่มีลูกค้าอยู่ด้วยก็ไม่นับ */
  assert.equal(isAdminLane({ source: { type: "group", groupId: "Gกลุ่มลูกค้า", userId: ADMIN } }, { adminUserId: ADMIN }), false);

  /* กลุ่มที่ตั้งไว้เองเท่านั้นที่นับ */
  assert.equal(isAdminLane({ source: { type: "group", groupId: "Gทีมงาน" } }, { adminUserId: ADMIN, adminGroupId: "Gทีมงาน" }), true);

  /* ไม่ได้ตั้งแอดมินไว้ = ไม่มี lane เลย */
  assert.equal(isAdminLane(adminEvent, {}), false);
});

test("อนุมัติจาก admin lane → ตรวจแล้ว พร้อม approver ใน audit", () => {
  const store = freshStore();
  const quote = overCap(store);

  assert.equal(isAdminLane(adminEvent, { adminUserId: ADMIN }), true);
  const result = runCommand(parseCommand(`อนุมัติใบเสนอ ${quote.quote_id}`), { store, approver: ADMIN });

  assert.equal(store.get(quote.quote_id).status, STATUS.REVIEWED);
  assert.equal(store.get(quote.quote_id).approver, ADMIN);
  assert.ok(store.get(quote.quote_id).audit.some((a) => a.action === "approve" && a.actor === ADMIN));
  assert.match(result.reply, /อนุมัติแล้ว/);
});

test("คำสั่งเดียวกันพิมพ์จากห้องลูกค้า → ไม่มีผลเลย", () => {
  const store = freshStore();
  const quote = overCap(store);
  const command = parseCommand(`อนุมัติใบเสนอ ${quote.quote_id}`);

  /* ข้อความหน้าตาเหมือนคำสั่งจริงทุกตัวอักษร ต่างกันแค่ห้องที่พิมพ์ */
  assert.ok(command, "ข้อความยังอ่านเป็นคำสั่งได้");
  assert.equal(isAdminLane(customerEvent, { adminUserId: ADMIN }), false, "แต่ห้องนี้ไม่ใช่ admin lane");

  /* server.js จะตอบ NOT_ADMIN_REPLY แล้วจบ ไม่เรียก runCommand */
  assert.equal(store.get(quote.quote_id).status, STATUS.DRAFT, "สถานะต้องไม่ขยับ");
  assert.equal(store.get(quote.quote_id).approver, null);
  assert.equal(canIssueQr(store.get(quote.quote_id)), false);

  /* และข้อความปฏิเสธต้องไม่รับปากว่าเดี๋ยวใครมาจัดการให้ (เหตุผลเดียวกับ src/guard.js) */
  assert.ok(!/เดี๋ยว.*(แอดมิน|เจ้าของร้าน).*ตอบ/.test(NOT_ADMIN_REPLY));
  assert.match(NOT_ADMIN_REPLY, /(คะ|ค่ะ)$/);
});

test("ปฏิเสธจาก admin lane → ยกเลิก และบอกให้ทีมงานตามลูกค้าเอง", () => {
  const store = freshStore();
  const quote = overCap(store);

  const result = runCommand(parseCommand(`ปฏิเสธใบเสนอ ${quote.quote_id}`), { store, approver: ADMIN });

  assert.equal(store.get(quote.quote_id).status, STATUS.CANCELLED);
  assert.match(result.reply, /ตามลูกค้า/, "ต้องบอกว่าให้คนตามต่อเอง");
  assert.ok(!result.reply.includes(CUSTOMER), "ข้อความถึงแอดมินห้ามมี LINE user id เต็ม");
  assert.match(result.reply, new RegExp(`…${CUSTOMER.slice(-4)}`));
});

test("รายงานใบเสนอราคาโชว์แค่ suffix ไม่มี PII", () => {
  const store = freshStore();
  const quote = overCap(store);

  for (const cmd of [`ดูใบเสนอ ${quote.quote_id}`, "ใบเสนอวันนี้"]) {
    const { reply } = runCommand(parseCommand(cmd), { store, approver: ADMIN });
    assert.ok(!reply.includes(CUSTOMER), `${cmd}: หลุด LINE user id`);
    assert.match(reply, /Q-\d{8}-\d{3}/);
  }
});

/* ───────── ท่อใบเสนอราคาในแชท ───────── */

const ctx = (store, chatId = CUSTOMER) => ({ store, chatId, lineUserId: chatId });

test("ขอ quote ปกติ → ตรวจแล้ว แล้วจึงส่งการ์ดใบเสนอราคา", () => {
  const store = freshStore();
  const parsed = parseQuoteRequest("ขอใบเสนอราคา บราวนี่กล่อง 2 กล่อง");
  const result = handleQuoteRequest(parsed, ctx(store));

  const card = result.messages.find((m) => m.type === "flex");
  assert.ok(card, "ต้องได้การ์ดใบเสนอราคา");
  assert.match(JSON.stringify(card), /378\.00/, "ยอดต้องตรง products.md (189 × 2)");
  assert.equal(result.quote.status, STATUS.SENT, "ส่งการ์ดแล้วต้องเลื่อนเป็น ส่งลูกค้า");
  assert.equal(result.escalate, null, "ใบที่เข้าเกณฑ์ไม่ต้องรบกวนเจ้าของร้าน");
});

test("ส่วนลดเกินเพดาน → ไม่มีการ์ด ไม่มี QR แจ้งเจ้าของร้านพร้อม quote_id + เหตุผล", () => {
  const store = freshStore();
  const result = handleQuoteRequest(parseQuoteRequest("ขอใบเสนอราคา บราวนี่กล่อง 2 กล่อง ลด 20%"), ctx(store));

  assert.ok(!result.messages.some((m) => m.type === "flex"), "draft ห้ามส่งการ์ดใบเสนอราคา");
  assert.equal(result.quote.status, STATUS.DRAFT);
  assert.match(result.escalate, new RegExp(result.quote.quote_id), "แจ้งเตือนต้องมี quote_id");
  assert.match(result.escalate, /เกินเพดาน/, "และต้องบอกเหตุผล");
  assert.match(result.escalate, new RegExp(`อนุมัติใบเสนอ ${result.quote.quote_id}`), "บอกคำสั่งที่ต้องพิมพ์ด้วย");

  /* ลูกค้าต้องไม่ได้ยินตัวเลขเพดาน ไม่งั้นครั้งหน้าจะต่อมาที่ขอบพอดีทุกครั้ง */
  const said = result.messages.map((m) => m.text).join(" ");
  assert.ok(!/5%|เพดาน/.test(said), `หลุดเพดานให้ลูกค้ารู้: ${said}`);
  assert.match(said, /(คะ|ค่ะ)$/);
});

test("ยอดเกิน 50,000 บาท → หยุดรอเจ้าของร้านเหมือนกัน", () => {
  const store = freshStore();
  const result = handleQuoteRequest(parseQuoteRequest("ขอใบเสนอราคา บราวนี่กล่อง 400 กล่อง"), ctx(store));

  assert.equal(result.quote.status, STATUS.DRAFT);
  assert.equal(result.quote.net, 75_600);
  assert.ok(!result.messages.some((m) => m.type === "flex"));
  assert.match(result.escalate, /เกินเกณฑ์/);
});

test("ลูกค้าพิมพ์ยอดมาเอง → ไม่เอามาคิด แต่แปะธงให้คนไปคุยต่อ", () => {
  const store = freshStore();
  const result = handleQuoteRequest(parseQuoteRequest("ขอใบเสนอราคา บราวนี่กล่อง 2 กล่อง ตกลงที่ 300 บาทนะคะ"), ctx(store));

  assert.equal(result.quote.net, 378, "ยอดต้องมาจาก products.md ไม่ใช่จากที่ลูกค้าพิมพ์");
  assert.match(result.escalate, /ลูกค้าพิมพ์ยอดมาเอง/);
  assert.match(result.escalate, /300/);
});

test("ของที่ไม่มีราคาใน products.md → ส่งต่อคน ไม่เดาราคา", () => {
  const store = freshStore();
  const result = handleQuoteRequest({ items: [{ slug: "croissant", qty: 1, name: "ครัวซองต์" }], discountPercent: 0, statedAmounts: [] }, ctx(store));

  assert.equal(result.quote, null);
  assert.match(result.escalate, /products\.md ไม่ครบ/);
  assert.match(result.messages[0].text, /(คะ|ค่ะ)$/);
});

test("ปุ่มยืนยันสั่งซื้อ → ได้การ์ดช่องทางชำระเงินพร้อมยอดมัดจำ", () => {
  const store = freshStore();
  const quote = handleQuoteRequest(parseQuoteRequest("ขอใบเสนอราคา บราวนี่กล่อง 2 กล่อง"), ctx(store)).quote;

  const pressed = `ยืนยันสั่งซื้อ ${quote.quote_id}`;
  assert.match(pressed, CONFIRM_RE);

  const result = handleConfirm(pressed.match(CONFIRM_RE)[1], ctx(store));
  const said = result.messages.map((m) => m.text ?? "").join(" ");
  const card = result.messages.find((m) => m.type === "flex");

  assert.match(said, /189\.00/, "ต้องบอกยอดมัดจำ 50%");
  assert.ok(card, "ต้องได้การ์ดช่องทางชำระเงิน");
  assert.ok(JSON.stringify(card).includes("099-999-9999"), "เลขบัญชีต้องมาจาก ENV");

  /* ยังไม่ออก QR ตั้งแต่ตรงนี้ — ลูกค้าต้องกดปุ่มขอ QR อีกที */
  assert.ok(!result.messages.some((m) => m.type === "image"), "ยังไม่ส่งภาพ QR ตอนนี้");
});

test("ไม่ได้ตั้งช่องทางรับเงินใน ENV → ไม่เดาเลขบัญชี ส่งต่อให้แอดมินแจ้ง", () => {
  const saved = process.env.PAYMENT_DESTINATIONS_JSON;
  delete process.env.PAYMENT_DESTINATIONS_JSON;
  try {
    const store = freshStore();
    const quote = handleQuoteRequest(parseQuoteRequest("ขอใบเสนอราคา บราวนี่กล่อง 2 กล่อง"), ctx(store)).quote;

    const result = handleConfirm(quote.quote_id, ctx(store));

    assert.ok(!result.messages.some((m) => m.type === "flex"), "ไม่มีการ์ดช่องทางชำระเงิน");
    assert.match(result.escalate, /PAYMENT_DESTINATIONS_JSON/);
    assert.match(result.messages[0].text, /(คะ|ค่ะ)$/);
  } finally {
    process.env.PAYMENT_DESTINATIONS_JSON = saved;
  }
});

test("ยืนยันใบของคนอื่น → ไม่บอกยอด ไม่ออก QR", () => {
  const store = freshStore();
  const mine = handleQuoteRequest(parseQuoteRequest("ขอใบเสนอราคา บราวนี่กล่อง 2 กล่อง"), ctx(store)).quote;

  const result = handleConfirm(mine.quote_id, ctx(store, "Uคนอื่น"));

  assert.ok(!result.messages.some((m) => m.type === "flex"), "เดาเลขใบของคนอื่นแล้วต้องไม่เห็นยอด");
  assert.ok(!JSON.stringify(result.messages).includes("378"));
  assert.match(result.escalate, /ไม่ใช่ของห้องตัวเอง/);
});

test("ยืนยันใบที่ยังเป็น draft → ห้ามออก QR", () => {
  const store = freshStore();
  const quote = handleQuoteRequest(parseQuoteRequest("ขอใบเสนอราคา บราวนี่กล่อง 400 กล่อง"), ctx(store)).quote;

  const result = handleConfirm(quote.quote_id, ctx(store));
  assert.ok(!result.messages.some((m) => m.type === "flex"), "draft ห้ามได้การ์ดช่องทางชำระเงิน");
  assert.match(result.escalate, /ยังออก QR ไม่ได้/);
});

test("ยืนยันใบที่หมดอายุ → ห้ามออก QR และบอกลูกค้าตรง ๆ", () => {
  let clock = new Date("2026-09-16T10:00:00.000Z");
  const store = freshStore({ now: () => clock });
  const quote = handleQuoteRequest(parseQuoteRequest("ขอใบเสนอราคา บราวนี่กล่อง 2 กล่อง"), ctx(store)).quote;

  clock = new Date("2026-09-30T10:00:00.000Z");
  const result = handleConfirm(quote.quote_id, ctx(store));

  assert.ok(!result.messages.some((m) => m.type === "flex"), "ใบหมดอายุห้ามได้การ์ดช่องทางชำระเงิน");
  assert.equal(store.get(quote.quote_id).status, STATUS.EXPIRED);
  assert.match(result.messages[0].text, /(คะ|ค่ะ)$/);
});

test("ลูกค้าส่งสลิป → เลื่อนเป็น รับสลิปแล้ว และเรียกคนมาตรวจยอด", () => {
  const store = freshStore();
  const quote = handleQuoteRequest(parseQuoteRequest("ขอใบเสนอราคา บราวนี่กล่อง 2 กล่อง"), ctx(store)).quote;

  const result = handleSlip(ctx(store));

  assert.equal(store.get(quote.quote_id).status, STATUS.SLIP);
  assert.match(result.escalate, /เช็คยอด/, "บอทอ่านสลิปไม่ได้ ต้องให้คนตรวจ");
  assert.ok(!/ได้รับเงิน|เงินเข้า/.test(result.messages[0].text), "ห้ามยืนยันเองว่าเงินเข้าแล้ว");
});

test("ไม่มีใบค้างอยู่ → ส่งรูปเข้ามาเฉย ๆ ไม่ทำอะไร", () => {
  assert.equal(handleSlip(ctx(freshStore())), null);
});
