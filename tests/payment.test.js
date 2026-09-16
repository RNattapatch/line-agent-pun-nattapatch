/*
 * เทสต์ช่องทางชำระเงิน · การออก QR · และการยืนยันยอดโดยเจ้าของร้าน
 *
 * เส้นที่ห้ามหลุดที่สุดในไฟล์นี้:
 *   1. เลขบัญชีมาจาก ENV เท่านั้น ไม่มีทางอื่น และห้ามโผล่ใน audit
 *   2. ยอดทุกยอดมาจาก record ของใบ ไม่ใช่จากข้อความหรือ postback ของลูกค้า
 *   3. ใบหมดอายุ / ใบที่ไม่ใช่ของคนกด / ใบที่ยังไม่ผ่านการตรวจ → ห้ามออก QR
 *   4. บอทไม่มีสิทธิ์บอกว่า "เงินเข้าแล้ว" — มีแต่คนที่เปิดแอปธนาคารดูเท่านั้น
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseCommand, runCommand } from "../src/admin.js";
import { auditRef, destinationById, paymentDestinations, qrDestinations } from "../src/payment.js";
import { SLIP_REPLY, confirmPayment, parsePostback, handleQrRequest } from "../src/payment-flow.js";
import { issueQr } from "../src/qr-issue.js";
import { STATUS, createQuoteStore } from "../src/quotes.js";

const CUSTOMER = "Uลูกค้า0000000000000000000000abcd";
const OTHER = "Uคนอื่น0000000000000000000000ffff";
const ADMIN = "Uแอดมิน00000000000000000000000000";
const BASE = "https://shop.example.com";

/* เลขสมมติ ไม่ใช่ของใคร */
const DESTINATIONS = [
  { id: "pp", type: "promptpay", label: "พร้อมเพย์", number: "099-999-9999" },
  { id: "kbank", type: "bank", label: "กสิกรไทย", number: "999-9-99999-9" },
];

const env = (extra = {}) => ({
  PAYMENT_ACCOUNT_NAME: "ร้านขนมปังสดสดสด (ทดสอบ)",
  PAYMENT_DESTINATIONS_JSON: JSON.stringify(DESTINATIONS),
  ...extra,
});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "payment-test-"));
const freshStore = (opts = {}) => createQuoteStore({ dir: path.join(tmp(), "quotes"), ...opts });

/* ใบที่ผ่านการตรวจแล้ว พร้อมออก QR */
const readyQuote = (store, lineUserId = CUSTOMER) =>
  store.create({ lineUserId, chatId: lineUserId, requested: [{ slug: "brownie-box", qty: 2 }] }).quote;

const list = () => paymentDestinations({ env: env() });
const qrDir = () => path.join(tmp(), "qr");

/* ═══ ช่องทางรับเงิน: ENV เท่านั้น ═══ */

test("อ่านช่องทางรับเงินจาก ENV และเติมชื่อบัญชีให้ทุกช่อง", () => {
  const got = list();
  assert.equal(got.length, 2);
  assert.equal(got[0].id, "pp");
  assert.equal(got[0].number, "099-999-9999");
  assert.equal(got[1].account_name, "ร้านขนมปังสดสดสด (ทดสอบ)", "ไม่ได้ระบุชื่อรายตัว → ใช้ PAYMENT_ACCOUNT_NAME");
  assert.deepEqual(qrDestinations(got).map((d) => d.id), ["pp"], "บัญชีธนาคารออก QR ไม่ได้");
});

test("ไม่ตั้ง ENV = ไม่มีช่องทางรับเงินเลย ไม่เดาจากที่อื่น", () => {
  assert.deepEqual(paymentDestinations({ env: {} }), []);
  /* context.md มีเบอร์พร้อมเพย์เขียนอยู่ แต่ต้องไม่ถูกหยิบมาใช้ */
  const ctx = fs.readFileSync(path.join(import.meta.dirname, "..", "context.md"), "utf8");
  assert.match(ctx, /พร้อมเพย์/, "context.md ยังมีข้อความเรื่องพร้อมเพย์อยู่จริง");
  assert.deepEqual(paymentDestinations({ env: { PAYMENT_ACCOUNT_NAME: "ร้าน" } }), [], "ต้องยังว่าง");
});

test("รายการที่กรอกผิดถูกตัดทิ้งทีละตัว ไม่ทำให้ทั้งร้านรับเงินไม่ได้", () => {
  const got = paymentDestinations({
    env: env({
      PAYMENT_DESTINATIONS_JSON: JSON.stringify([
        { id: "ok", type: "promptpay", label: "พร้อมเพย์", number: "099-999-9999" },
        { id: "ไทย", type: "promptpay", label: "พร้อมเพย์", number: "099-999-9999" }, // id ผิดรูปแบบ
        { id: "x", type: "crypto", label: "เหรียญ", number: "099-999-9999" }, // ชนิดไม่รองรับ
        { id: "y", type: "bank", label: "ธนาคาร", number: "ไม่ใช่ตัวเลข" }, // เลขผิดรูปแบบ
        { id: "ok", type: "bank", label: "ซ้ำ", number: "999-9-99999-9" }, // id ซ้ำ
      ]),
    }),
  });
  assert.deepEqual(got.map((d) => d.id), ["ok"]);
});

test("JSON พัง → ถือว่าไม่มีช่องทาง ไม่ล้มทั้งระบบ", () => {
  assert.deepEqual(paymentDestinations({ env: env({ PAYMENT_DESTINATIONS_JSON: "{ไม่ใช่ json" }) }), []);
  assert.deepEqual(paymentDestinations({ env: env({ PAYMENT_DESTINATIONS_JSON: '{"id":"pp"}' }) }), [], "ต้องเป็น array");
});

test("ตัวอ้างอิงที่ลง audit มีแต่ id กับชนิด ไม่มีเลขบัญชี", () => {
  const ref = auditRef(list()[0]);
  assert.deepEqual(ref, { dest_id: "pp", dest_type: "promptpay" });
  assert.ok(!JSON.stringify(ref).includes("999"), "เลขบัญชีห้ามติดไปกับ audit");
});

test("หาช่องทางตาม id ที่ไม่มีอยู่ → null ไม่เดาเป็นตัวแรก", () => {
  assert.equal(destinationById("ไม่มีจริง", list()), null);
  assert.equal(destinationById("", list()), null);
  assert.equal(destinationById("PP", list())?.id, "pp", "ตัวพิมพ์ใหญ่ยังหาเจอ");
});

/* ═══ postback: พก quote_id เสมอ ห้ามพกยอด ═══ */

test("postback ต้องมี quote_id ที่รูปแบบถูกต้อง", () => {
  assert.deepEqual(parsePostback("action=qr&quote_id=Q-20260916-001&dest=pp&kind=deposit"), {
    action: "qr",
    quoteId: "Q-20260916-001",
    destId: "pp",
    kind: "deposit",
  });
  assert.equal(parsePostback("action=qr&dest=pp"), null, "ไม่มี quote_id = ไม่รับ");
  assert.equal(parsePostback("action=qr&quote_id=Q-2026-1&dest=pp"), null, "รูปแบบเลขใบผิด = ไม่รับ");
  assert.equal(parsePostback("action=ลบใบ&quote_id=Q-20260916-001"), null, "action ที่ไม่รู้จัก = ไม่รับ");
  assert.equal(parsePostback(""), null);
  assert.equal(parsePostback(null), null);
});

test("postback ที่พกยอดมาเอง → ปฏิเสธทั้งคำขอ", () => {
  for (const key of ["amount", "total", "price", "net", "deposit"]) {
    const got = parsePostback(`action=qr&quote_id=Q-20260916-001&dest=pp&${key}=1`);
    assert.equal(got.action, "rejected", `ต้องปฏิเสธเมื่อมี ${key}`);
  }
});

test("kind ที่ไม่รู้จักตกลงมาเป็นมัดจำ ไม่ใช่ยอดเต็ม", () => {
  /* พลาดทางไหนก็ตาม ต้องพลาดไปทางที่เรียกเก็บน้อยกว่า ไม่ใช่มากกว่า */
  assert.equal(parsePostback("action=qr&quote_id=Q-20260916-001&dest=pp&kind=อะไรก็ไม่รู้").kind, "deposit");
});

/* ═══ ด่านออก QR ═══ */

test("ใบที่ตรวจแล้ว + เป็นของคนกด → ออก QR ได้ ยอดมาจาก record", () => {
  const store = freshStore();
  const quote = readyQuote(store);
  assert.equal(quote.status, STATUS.REVIEWED);

  const res = issueQr({ store, quoteId: quote.quote_id, lineUserId: CUSTOMER, destination: list()[0], dir: qrDir() });

  assert.equal(res.ok, true);
  assert.equal(res.amount, quote.deposit, "ยอดต้องเท่ากับมัดจำใน record เป๊ะ");
  assert.match(res.token, /^[0-9a-f]{32}$/, "ชื่อไฟล์ต้องเดาไม่ได้");
  assert.ok(fs.existsSync(res.file), "ต้องมีไฟล์ภาพจริง");
  assert.equal(fs.statSync(res.file).mode & 0o777, 0o600, "ไฟล์ต้องอ่านได้เฉพาะเจ้าของ");
  assert.equal(store.get(quote.quote_id).status, STATUS.SENT, "ส่ง QR แล้วต้องเลื่อนเป็น ส่งลูกค้า");
});

test("audit บันทึกว่าออก QR ยอดเท่าไหร่ ช่องทางไหน — แต่ไม่มีเลขบัญชีและไม่มีชื่อไฟล์", () => {
  const store = freshStore();
  const quote = readyQuote(store);
  const res = issueQr({ store, quoteId: quote.quote_id, lineUserId: CUSTOMER, destination: list()[0], dir: qrDir() });

  const entry = store.get(quote.quote_id).audit.find((a) => a.action === "qr-issued");
  assert.ok(entry);
  assert.equal(entry.amount, quote.deposit);
  assert.equal(entry.dest_id, "pp");

  const trail = JSON.stringify(store.get(quote.quote_id).audit);
  assert.ok(!trail.includes("099-999-9999"), "เลขบัญชีห้ามอยู่ในไฟล์ใบเสนอราคา");
  assert.ok(!trail.includes(res.token), "ชื่อไฟล์ภาพคือ URL ที่เปิดดูได้ ห้ามเก็บไว้");
  assert.ok(!trail.includes("00020101"), "payload ของ QR ห้ามถูกเก็บ");
});

test("ใบของคนอื่น → ไม่ออก QR ต่อให้เดาเลขใบถูก", () => {
  const store = freshStore();
  const quote = readyQuote(store, CUSTOMER);

  const res = issueQr({ store, quoteId: quote.quote_id, lineUserId: OTHER, destination: list()[0], dir: qrDir() });

  assert.equal(res.ok, false);
  assert.equal(res.reason, "not-yours");
  assert.equal(res.quote, null, "ห้ามคืน record ของคนอื่นกลับไปให้ผู้เรียกด้วยซ้ำ");
  assert.equal(store.get(quote.quote_id).status, STATUS.REVIEWED, "สถานะห้ามขยับ");
});

test("ไม่รู้ว่าใครกด (ไม่มี LINE user id) → ไม่ออก QR", () => {
  const store = freshStore();
  const quote = readyQuote(store);
  const res = issueQr({ store, quoteId: quote.quote_id, lineUserId: null, destination: list()[0], dir: qrDir() });
  assert.equal(res.reason, "not-yours");
});

/* ═══ Acceptance 2: ใบหมดอายุต้องไม่ออก QR ═══ */
test("ใบที่เลยกำหนดยืนราคา → ไม่ออก QR และไม่มีไฟล์ภาพเกิดขึ้นเลย", () => {
  let clock = new Date("2026-09-16T10:00:00.000Z");
  const store = freshStore({ now: () => clock });
  const quote = readyQuote(store);
  const dir = qrDir();

  clock = new Date("2026-09-30T10:00:00.000Z"); // เลย 3 วันไปไกล
  const res = issueQr({ store, quoteId: quote.quote_id, lineUserId: CUSTOMER, destination: list()[0], dir, now: () => clock });

  assert.equal(res.ok, false);
  assert.equal(res.reason, "expired");
  assert.equal(store.get(quote.quote_id).status, STATUS.EXPIRED);
  assert.equal(fs.existsSync(dir), false, "ห้ามมีไฟล์ QR เกิดขึ้นแม้แต่ไฟล์เดียว");
});

test("ใบที่ยังเป็น draft (ส่วนลดเกินเพดาน) → ไม่ออก QR", () => {
  const store = freshStore();
  const quote = store.create({
    lineUserId: CUSTOMER,
    chatId: CUSTOMER,
    requested: [{ slug: "brownie-box", qty: 1 }],
    discountPercent: 30,
  }).quote;
  assert.equal(quote.status, STATUS.DRAFT);

  const res = issueQr({ store, quoteId: quote.quote_id, lineUserId: CUSTOMER, destination: list()[0], dir: qrDir() });
  assert.equal(res.reason, "status");
});

test("ใบที่รับสลิปแล้ว → ไม่ออก QR ซ้ำ (กันลูกค้าโอนรอบสอง)", () => {
  const store = freshStore();
  const quote = readyQuote(store);
  store.advance(quote.quote_id, STATUS.SENT);
  store.advance(quote.quote_id, STATUS.SLIP);

  const res = issueQr({ store, quoteId: quote.quote_id, lineUserId: CUSTOMER, destination: list()[0], dir: qrDir() });
  assert.equal(res.reason, "status");
});

test("ช่องทางที่ออก QR ไม่ได้ (บัญชีธนาคาร) → ปฏิเสธ ไม่แอบใช้ช่องทางอื่นแทน", () => {
  const store = freshStore();
  const quote = readyQuote(store);
  const bank = list().find((d) => d.type === "bank");

  const res = issueQr({ store, quoteId: quote.quote_id, lineUserId: CUSTOMER, destination: bank, dir: qrDir() });
  assert.equal(res.reason, "no-destination");
  assert.equal(store.get(quote.quote_id).status, STATUS.REVIEWED);
});

test("ขอ QR ยอดเต็ม → ได้ยอดสุทธิ ไม่ใช่มัดจำ", () => {
  const store = freshStore();
  const quote = readyQuote(store);

  const res = issueQr({
    store, quoteId: quote.quote_id, lineUserId: CUSTOMER, destination: list()[0], amountKind: "full", dir: qrDir(),
  });
  assert.equal(res.amount, quote.net);
  assert.notEqual(quote.net, quote.deposit, "เทสต์นี้จะไม่มีความหมายถ้ายอดสองตัวเท่ากัน");
});

test("ส่ง QR ไม่ได้ถ้า PUBLIC_BASE_URL ไม่ใช่ https — และต้องบอกแอดมินให้ส่งเอง", () => {
  const store = freshStore();
  const quote = readyQuote(store);

  const res = handleQrRequest({
    store,
    quoteId: quote.quote_id,
    lineUserId: CUSTOMER,
    destId: "pp",
    kind: "deposit",
    baseUrl: "http://localhost:3000",
    deps: { destinations: list(), issueQr: (a) => issueQr({ ...a, dir: qrDir() }) },
  });

  assert.ok(!res.messages.some((m) => m.type === "image"));
  assert.match(res.escalate, /PUBLIC_BASE_URL/);
});

test("ลูกค้าไม่ได้ยินเหตุผลเชิงกลไก ส่วนแอดมินได้ยิน", () => {
  const store = freshStore();
  const quote = readyQuote(store, CUSTOMER);

  const res = handleQrRequest({
    store,
    quoteId: quote.quote_id,
    lineUserId: OTHER,
    destId: "pp",
    kind: "deposit",
    baseUrl: BASE,
    deps: { destinations: list(), issueQr: (a) => issueQr({ ...a, dir: qrDir() }) },
  });

  const said = res.messages.map((m) => m.text).join(" ");
  assert.ok(!/สถานะ|not-yours|draft/.test(said), "ห้ามบอกลูกค้าว่าติดด่านไหน");
  assert.match(said, /(คะ|ค่ะ)$/);
  assert.match(res.escalate, /ไม่ใช่ของห้องตัวเอง/, "แอดมินต้องได้ยินว่ามีคนขอใบของคนอื่น");
});

/* ═══ Acceptance 3-4: ยืนยันยอดโดยเจ้าของร้าน ═══ */

test("รับสลิปแล้ว → แอดมินยืนยันยอด → ยืนยันชำระแล้ว + ลูกค้าได้ข้อความ", () => {
  const store = freshStore();
  const quote = readyQuote(store);
  store.advance(quote.quote_id, STATUS.SENT);
  store.advance(quote.quote_id, STATUS.SLIP);

  const command = parseCommand(`ยืนยันยอด ${quote.quote_id}`);
  assert.deepEqual(command, { name: "confirm", quoteId: quote.quote_id });

  const res = runCommand(command, { store, approver: ADMIN });

  assert.equal(store.get(quote.quote_id).status, STATUS.PAID);
  assert.equal(store.get(quote.quote_id).approver, ADMIN);
  assert.match(res.reply, /ยืนยันชำระแล้ว/);
  assert.equal(res.customerMessages.length, 1, "ลูกค้าต้องได้ข้อความยืนยัน");
  assert.match(res.customerMessages[0].text, /ยืนยันการชำระเงิน/);

  const entry = store.get(quote.quote_id).audit.find((a) => a.action === "confirm-payment");
  assert.equal(entry.actor, ADMIN, "ต้องรู้ว่าใครเป็นคนยืนยัน");
});

test("ยืนยันใบที่ยังไม่รับสลิป → ถูกปฏิเสธ สถานะไม่ขยับ แต่มี audit", () => {
  const store = freshStore();
  const quote = readyQuote(store);
  store.advance(quote.quote_id, STATUS.SENT); // ส่งลูกค้าแล้ว แต่ยังไม่มีสลิป

  const res = confirmPayment(quote.quote_id, { store, approver: ADMIN });

  assert.equal(store.get(quote.quote_id).status, STATUS.SENT, "สถานะห้ามขยับเด็ดขาด");
  assert.match(res.reply, /ยังไม่ถึงขั้นรับสลิป/);
  assert.deepEqual(res.customerMessages, [], "ห้ามมีอะไรวิ่งไปหาลูกค้า");

  const entry = store.get(quote.quote_id).audit.find((a) => a.action === "confirm-rejected");
  assert.ok(entry, "ความพยายามยืนยันต้องเหลือร่องรอย");
  assert.equal(entry.attempted_from, STATUS.SENT);
  assert.equal(entry.actor, ADMIN);
});

test("ยืนยันซ้ำหลังจ่ายแล้ว → ถูกปฏิเสธ และมีร่องรอยของความพยายามครั้งที่สอง", () => {
  const store = freshStore();
  const quote = readyQuote(store);
  store.advance(quote.quote_id, STATUS.SENT);
  store.advance(quote.quote_id, STATUS.SLIP);

  confirmPayment(quote.quote_id, { store, approver: ADMIN });
  const again = confirmPayment(quote.quote_id, { store, approver: ADMIN });

  assert.match(again.reply, /❌/);
  assert.equal(store.get(quote.quote_id).status, STATUS.PAID);
  const rejected = store.get(quote.quote_id).audit.filter((a) => a.action === "confirm-rejected");
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].attempted_from, STATUS.PAID);
});

test("ยืนยันใบที่ไม่มีอยู่ → ไม่พัง", () => {
  const res = confirmPayment("Q-20260101-999", { store: freshStore(), approver: ADMIN });
  assert.match(res.reply, /ไม่พบ/);
  assert.deepEqual(res.customerMessages, []);
});

test("ข้อความก่อนยืนยันต้องเป็น 'รับสลิปแล้ว รอตรวจ' ไม่ใช่คำที่ฟังเหมือนเงินเข้าแล้ว", () => {
  assert.match(SLIP_REPLY, /ตรวจสอบ/);
  assert.ok(!/(เงินเข้า|ได้รับเงิน|ชำระเรียบร้อย|ยืนยันแล้ว)/.test(SLIP_REPLY));
  assert.match(SLIP_REPLY, /(คะ|ค่ะ)$/);
});

test("คำสั่งยืนยันยอดต้องพิมพ์เต็มรูปแบบ ไม่รับตัวย่อและไม่รับยอดต่อท้าย", () => {
  assert.equal(parseCommand("ยืนยัน Q-20260916-001"), null);
  assert.equal(parseCommand("ยืนยันยอด Q-20260916-001 378"), null, "ยอดต้องมาจากใบ ไม่ใช่จากที่แอดมินพิมพ์");
  assert.equal(parseCommand("ยืนยันยอด"), null);
});
