/*
 * เทสต์ยาม 2 ตัว + ท่อสลิป + เกราะสนทนา — หน่วยย่อยของแต่ละชิ้น
 * ส่วนเส้นทางเต็มที่เดินเหมือนคนถือมือถืออยู่ใน tests/scenario.test.js
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAdminClaims } from "../src/admin-claim.js";
import { createEventLog, bangkokDate, bangkokStamp } from "../src/customer-events.js";
import { renderEveningReport, runEveningReport, summarize } from "../src/evening-report.js";
import { createFaultBox, FAULTS, FAULT_TTL_MS } from "../src/faults.js";
import { createIncidentLog, FAILURE_CLASSES } from "../src/incidents.js";
import { createMediaStore } from "../src/media.js";
import { createReports } from "../src/reports.js";
import { bangkokWallClockToUtc, createScheduler, nextRunAt, parseHHMM } from "../src/scheduler.js";
import { CONFIRM_TTL_MS, MONEY_WORDS, NEUTRAL_IMAGE_REPLY, classifyImage, createSlipWaiters, eligibleQuotes } from "../src/slip-flow.js";
import { TRIGGERS, createUrgentGuard } from "../src/urgent-guard.js";
import { createQuoteStore, STATUS } from "../src/quotes.js";
import { hasSystemTerms } from "../src/safe-reply.js";

const quiet = { log() {}, warn() {}, error() {} };
const tmp = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "guards-")), name);
const USER = "Uลูกค้า0000000000000000000000abcd";
const OWNER = "Uเจ้าของ000000000000000000000001";

/* ═══════════ ① ตัวเก็บเหตุการณ์ ═══════════ */

test("เก็บเหตุการณ์ลงไฟล์รายวันตามวันไทย โฟลเดอร์ 700 ไฟล์ 600", () => {
  const events = createEventLog({ dir: tmp("customer-events") });
  const rec = events.append({ chatId: USER, intent: "ask_price", lead: "warm" });

  assert.equal(rec.suffix, "abcd");
  assert.match(rec.at, /\+07:00$/, "เวลาต้องเป็นเวลาไทยพร้อม offset");
  assert.equal(fs.statSync(events.dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(events.dir, `${bangkokDate()}.jsonl`)).mode & 0o777, 0o600);
  assert.equal(events.readDay().length, 1);
});

test("ไม่เก็บ LINE user id เต็ม และไม่เก็บบทสนทนาดิบ", () => {
  const events = createEventLog({ dir: tmp("customer-events") });
  events.append({ chatId: USER, intent: "ask_price", lead: "warm", handoff: "ส่วนลดเกินเพดาน" });

  const raw = fs.readFileSync(path.join(events.dir, `${bangkokDate()}.jsonl`), "utf8");
  assert.ok(!raw.includes(USER), "userId เต็มห้ามอยู่ในไฟล์");
  assert.ok(raw.includes("abcd"), "เก็บแค่ 4 ตัวท้าย");

  const rec = JSON.parse(raw);
  assert.deepEqual(
    Object.keys(rec).sort(),
    ["at", "handoff", "id", "intent", "lead", "next_step", "suffix", "triggers", "unanswered"],
    "ฟิลด์ต้องมีเท่าที่โจทย์กำหนด ไม่มีอะไรงอกเพิ่ม",
  );
});

test("ใช้วันไทยไม่ใช่ UTC — บทสนทนาตอนหัวค่ำต้องไม่ถูกนับเป็นเมื่อวาน", () => {
  /* 2026-09-16 19:00 ไทย = 12:00 UTC · แต่ 2026-09-17 00:30 ไทย = 17:30 UTC ของวันที่ 16 */
  assert.equal(bangkokDate(new Date("2026-09-16T12:00:00Z")), "2026-09-16");
  assert.equal(bangkokDate(new Date("2026-09-16T17:30:00Z")), "2026-09-17");
  assert.equal(bangkokStamp(new Date("2026-09-16T17:30:00Z")), "2026-09-17T00:30:00+07:00");
});

test("ลบไฟล์ที่เกินกำหนดเก็บ 30 วัน", () => {
  const dir = tmp("customer-events");
  fs.mkdirSync(dir, { recursive: true });
  const old = bangkokDate(new Date(Date.now() - 40 * 86400_000));
  const recent = bangkokDate(new Date(Date.now() - 3 * 86400_000));
  for (const d of [old, recent]) fs.writeFileSync(path.join(dir, `${d}.jsonl`), "{}\n");

  const events = createEventLog({ dir });
  assert.equal(events.sweep(), 1);
  assert.deepEqual(events.days(), [recent]);
});

/* ═══════════ ① รายงานเย็น ═══════════ */

const sampleDay = [
  { at: "2026-09-16T09:00:00+07:00", suffix: "aaaa", intent: "greeting", lead: "cold", handoff: null, unanswered: null, next_step: null },
  { at: "2026-09-16T09:05:00+07:00", suffix: "aaaa", intent: "ask_price", lead: "warm", handoff: null, unanswered: null, next_step: null },
  { at: "2026-09-16T10:00:00+07:00", suffix: "bbbb", intent: "ask_quote", lead: "hot", handoff: "ส่วนลด 20% เกินเพดาน", unanswered: null, next_step: "อนุมัติใบเสนอ Q-1" },
  { at: "2026-09-16T11:00:00+07:00", suffix: "cccc", intent: "other", lead: "cold", handoff: null, unanswered: "มีสาขาเชียงใหม่ไหม", next_step: null },
];

test("สรุปตัวเลข: ห้องเดียวกันนับครั้งเดียว และใช้เกรดที่ร้อนที่สุดของวัน", () => {
  const s = summarize(sampleDay);
  assert.equal(s.rooms, 3, "3 ห้อง ไม่ใช่ 4 เหตุการณ์");
  assert.deepEqual(s.byGrade, { hot: 1, warm: 1, cold: 1 });
  assert.equal(s.handoffs.length, 1);
  assert.equal(s.unanswered.length, 1);
});

test("รายงานมีครบ 6 หัวข้อตามลำดับที่กำหนด", () => {
  const out = renderEveningReport(sampleDay, { date: "2026-09-16" });
  const order = ["ลูกค้าใหม่", "Lead แยกเกรด", "เคสต้องตามด่วน", "คำถามยอดฮิต", "คำถามที่ตอบไม่ได้", "สิ่งที่เจ้าของต้องทำต่อ"];
  let cursor = -1;
  for (const heading of order) {
    const at = out.indexOf(heading);
    assert.ok(at > cursor, `หัวข้อ "${heading}" ไม่อยู่ในลำดับที่ถูกต้อง`);
    cursor = at;
  }
  assert.ok(out.includes("hot 1 ราย") && out.includes("warm 1 ราย") && out.includes("cold 1 ราย"));
});

test("วันที่ไม่มีข้อมูล → บอกตรง ๆ ห้ามสร้างตัวเลข", () => {
  const out = renderEveningReport([], { date: "2026-09-16" });
  assert.match(out, /วันนี้ยังไม่มีบทสนทนาใหม่/);
  assert.match(out, /สิ่งที่เจ้าของต้องทำต่อ/, "ยังต้องมีบรรทัดปิดเสมอ");
  assert.ok(!/[1-9]\d* (ราย|ห้อง|เคส|ครั้ง|ข้อ)/.test(out), `มีตัวเลขโผล่ในรายงานวันที่ไม่มีข้อมูล:\n${out}`);
});

test("ตัวเลขในรายงานมาจากไฟล์ของวันนั้นจริง ๆ", async () => {
  const dir = tmp("customer-events");
  const events = createEventLog({ dir });
  for (let i = 0; i < 3; i++) events.append({ chatId: `Uxx${i}`, intent: "ask_price", lead: "warm" });
  events.append({ chatId: "Uyy", intent: "ask_quote", lead: "hot", handoff: "ยอดเกินเกณฑ์" });

  const sent = [];
  const claims = createAdminClaims({ dir: tmp("admin") });
  claims.claim(claims.issue().code, OWNER);
  const reports = createReports({ dir: claims.dir, claims, log: quiet, push: async (a) => sent.push(a) });

  const res = await runEveningReport({ events, reports, testRun: true });
  assert.equal(res.count, 4);
  assert.match(res.text, /4 ห้อง \(4 เหตุการณ์\)/);
  assert.match(res.text, /\[สั่งรันเอง\]/, "ต้องติดป้ายว่าเป็นการสั่งรันเอง");
  assert.equal(sent.length, 1, "ส่งให้แอดมิน 1 ข้อความ");
});

/* ═══════════ ① scheduler ═══════════ */

test("ตั้งเวลา 18:30 เวลาไทย = 11:30 UTC และข้ามไปวันถัดไปเมื่อเลยเวลาแล้ว", () => {
  const at = parseHHMM("18:30");
  assert.equal(bangkokWallClockToUtc("2026-09-16", at), Date.parse("2026-09-16T11:30:00Z"));
  assert.equal(nextRunAt(new Date("2026-09-16T11:29:00Z"), at), Date.parse("2026-09-16T11:30:00Z"));
  assert.equal(nextRunAt(new Date("2026-09-16T11:31:00Z"), at), Date.parse("2026-09-17T11:30:00Z"));
  /* เที่ยงคืนของไทยคือ 17:00 UTC ของวันก่อนหน้า — จุดที่พังง่ายที่สุดถ้าคิด timezone ผิด */
  assert.equal(nextRunAt(new Date("2026-09-16T17:00:00Z"), at), Date.parse("2026-09-17T11:30:00Z"));
});

test("เวลาที่ตั้งผิดรูปแบบ → ตกไปใช้ค่าเริ่มต้น ไม่พัง", () => {
  for (const bad of ["", null, "25:00", "18:70", "ตอนเย็น", "1830"]) {
    assert.equal(parseHHMM(bad).label, "18:30", `ต้องตกไปใช้ค่าเริ่มต้น: ${bad}`);
  }
  assert.equal(parseHHMM("07:05").label, "07:05");
});

test("รีสตาร์ตหลังเลยเวลา → รันตามให้ และไม่รันซ้ำถ้า deploy อีกรอบ", async () => {
  const dir = tmp("customer-events");
  const runs = [];
  let clock = new Date("2026-09-16T12:00:00Z"); // ไทย 19:00 — เลย 18:30 ไปแล้ว
  const make = () =>
    createScheduler({
      dir,
      eveningAt: "18:30",
      runEvening: async (a) => {
        runs.push(a);
        return { deliver: "admin" };
      },
      now: () => clock,
      log: quiet,
    });

  assert.equal((await make().catchUp()).caughtUp, true, "deploy ครั้งแรกหลังเลยเวลา → ต้องรันตาม");
  assert.equal(runs.length, 1);
  assert.equal(runs[0].testRun, false, "รอบ catch-up ไม่ใช่ test run");

  assert.equal((await make().catchUp()).caughtUp, false, "deploy ซ้ำวันเดียวกัน → ห้ามส่งซ้ำ");
  assert.equal(runs.length, 1);

  clock = new Date("2026-09-17T12:00:00Z"); // วันถัดไป
  assert.equal((await make().catchUp()).caughtUp, true, "วันใหม่ต้องรันใหม่");
  assert.equal(runs.length, 2);
});

test("ยังไม่ถึงเวลา → ไม่รันตาม", async () => {
  const clock = new Date("2026-09-16T04:00:00Z"); // ไทย 11:00
  const runs = [];
  const s = createScheduler({ dir: tmp("customer-events"), eveningAt: "18:30", runEvening: async () => runs.push(1), now: () => clock, log: quiet });
  assert.equal((await s.catchUp()).caughtUp, false);
  assert.equal(runs.length, 0);
});

test("ส่งรายงานไม่สำเร็จ → ห้ามจำว่ารันแล้ว ไม่งั้นวันนั้นจะไม่มีรายงานตลอดกาล", async () => {
  const dir = tmp("customer-events");
  const clock = new Date("2026-09-16T12:00:00Z");
  let fail = true;
  const runs = [];
  const make = () =>
    createScheduler({
      dir, eveningAt: "18:30", now: () => clock, log: quiet,
      runEvening: async (a) => {
        if (fail) throw new Error("ส่งไม่ผ่าน");
        runs.push(a);
        return { deliver: "admin" };
      },
    });

  await make().catchUp();
  assert.equal(runs.length, 0);
  fail = false;
  await make().catchUp();
  assert.equal(runs.length, 1, "รอบถัดมาต้องยังลองส่งอีก");
});

/* ═══════════ ② ยามแจ้งด่วน ═══════════ */

function urgentRig() {
  const dir = tmp("customer-events");
  const events = createEventLog({ dir });
  const claims = createAdminClaims({ dir: tmp("admin") });
  const sent = [];
  const reports = createReports({ dir: claims.dir, claims, log: quiet, push: async (a) => sent.push(a) });
  const guard = createUrgentGuard({ events, reports, dir, log: quiet });
  return { events, claims, reports, guard, sent, becomeAdmin: () => claims.claim(claims.issue().code, OWNER) };
}

test("เหตุแจ้งด่วนครบ 8 แบบตามที่ร้านกำหนด", () => {
  assert.deepEqual(Object.keys(TRIGGERS), [
    "over_discount", "high_value", "ask_owner", "complaint",
    "slip_in", "new_appointment", "delivery_appointment", "pickup_request",
  ]);
  for (const t of Object.values(TRIGGERS)) assert.ok(t.next, `${t.label} ต้องมี "สิ่งที่เจ้าของต้องทำต่อ"`);
});

test("แจ้งด่วนมีเวลาไทย · suffix · สรุปสั้น · สิ่งที่ต้องทำต่อ", async () => {
  const r = urgentRig();
  r.becomeAdmin();
  r.events.append({ chatId: USER, intent: "ask_quote", lead: "hot", handoff: "ส่วนลด 20% เกินเพดาน 5%", nextStep: "อนุมัติใบเสนอ Q-1", triggers: ["over_discount"] });

  await r.guard.tick();
  const text = r.sent.flatMap((s) => s.messages).map((m) => m.text).join("\n");
  assert.match(text, /ต่อรองเกินเพดาน/);
  assert.match(text, /\d\d:\d\d น\./, "ต้องมีเวลาไทย");
  assert.match(text, /ห้อง …abcd/, "ต้องมี suffix 4 ตัว");
  assert.match(text, /ต้องทำต่อ: อนุมัติใบเสนอ Q-1/);
  assert.ok(!text.includes(USER), "ห้ามมี userId เต็ม");
});

test("กวาดกี่รอบก็แจ้งครั้งเดียว — dedupe ต่อ event ต่อ trigger", async () => {
  const r = urgentRig();
  r.becomeAdmin();
  r.events.append({ chatId: USER, intent: "ask_quote", lead: "hot", triggers: ["over_discount"] });

  assert.equal((await r.guard.tick()).sent, 1);
  assert.equal((await r.guard.tick()).sent, 0, "รอบสองต้องไม่ส่งซ้ำ");
  assert.equal((await r.guard.tick()).sent, 0);
  assert.equal(r.sent.length, 1);

  const log = Object.values(r.guard.sentLog())[0];
  assert.equal(log.result, "sent");
  assert.match(log.sent_at, /^\d\d:\d\d$/, "ต้องบันทึกเวลาที่ส่ง");
});

test("หนึ่ง event ติดหลาย trigger → แจ้งแยกกันคนละเรื่อง", async () => {
  const r = urgentRig();
  r.becomeAdmin();
  r.events.append({ chatId: USER, intent: "ask_quote", lead: "hot", triggers: ["over_discount", "high_value"] });

  assert.equal((await r.guard.tick()).sent, 2);
  assert.equal((await r.guard.tick()).sent, 0);
});

test("ยังไม่มีแอดมิน → เข้าคิว แล้วพอ claim ค่อยไหลเข้า และไม่แจ้งซ้ำหลังจากนั้น", async () => {
  const r = urgentRig();
  r.events.append({ chatId: USER, intent: "complaint", lead: "cold", triggers: ["complaint"] });

  await r.guard.tick();
  assert.equal(r.sent.length, 0, "ก่อน claim ห้ามยิงหาใคร");
  assert.equal(r.reports.spoolSize(), 1);

  r.becomeAdmin();
  await r.reports.flush();
  assert.equal(r.sent.length, 1);

  await r.guard.tick();
  assert.equal(r.sent.length, 1, "กวาดรอบใหม่ต้องไม่แจ้งซ้ำเรื่องเดิม");
});

test("trigger ที่ไม่รู้จัก → ข้ามไป ไม่พัง", async () => {
  const r = urgentRig();
  r.becomeAdmin();
  r.events.append({ chatId: USER, intent: "other", lead: "cold", triggers: ["ไม่มีเหตุนี้"] });
  assert.equal((await r.guard.tick()).sent, 0);
});

/* ═══════════ ③ ท่อสลิป ═══════════ */

const quoteStore = () => createQuoteStore({ dir: tmp("quotes") });
const sentQuote = (store, user = USER) => {
  const q = store.create({ lineUserId: user, chatId: user, requested: [{ slug: "brownie-box", qty: 2 }] }).quote;
  store.advance(q.quote_id, STATUS.SENT);
  return store.get(q.quote_id);
};

test("ไม่มีใบค้าง → ข้อความกลาง ๆ ที่ไม่มีคำว่า สลิป/ยอด/ชำระ", () => {
  const v = classifyImage({ store: quoteStore(), lineUserId: USER });
  assert.equal(v.kind, "neutral");
  assert.equal(v.messages[0].text, NEUTRAL_IMAGE_REPLY);
  assert.ok(!MONEY_WORDS.test(v.messages[0].text), `ห้ามมีคำเรื่องเงิน: ${v.messages[0].text}`);
});

test("มีใบค้าง 1 ใบ → ถามยืนยันโดยระบุ quote_id + ยอด", () => {
  const store = quoteStore();
  const q = sentQuote(store);
  const v = classifyImage({ store, lineUserId: USER });

  assert.equal(v.kind, "confirm");
  assert.match(v.messages[0].text, new RegExp(q.quote_id));
  assert.match(v.messages[0].text, /189\.00/);
  assert.match(v.messages[0].text, /ใช่ไหมคะ/);
  assert.deepEqual(v.messages[0].quickReply.items.map((i) => i.action.label), ["ใช่ค่ะ", "ไม่ใช่ค่ะ"]);
});

test("มีใบค้างหลายใบ → ให้เลือกก่อน พร้อมยอดของแต่ละใบ", () => {
  const store = quoteStore();
  const a = sentQuote(store);
  const b = sentQuote(store);
  const v = classifyImage({ store, lineUserId: USER });

  assert.equal(v.kind, "pick");
  for (const q of [a, b]) assert.ok(v.messages[0].text.includes(q.quote_id), `ขาดใบ ${q.quote_id}`);
  assert.equal(v.messages[0].quickReply.items.length, 2);
});

test("ใบที่หมดอายุ / ยังไม่ส่งลูกค้า ไม่นับเป็นใบที่รอสลิป", () => {
  let clock = new Date("2026-09-16T10:00:00Z");
  const store = createQuoteStore({ dir: tmp("quotes"), now: () => clock });
  const q = store.create({ lineUserId: USER, chatId: USER, requested: [{ slug: "brownie-box", qty: 1 }] }).quote;

  assert.equal(eligibleQuotes(store, USER, () => clock).length, 0, "ตรวจแล้วแต่ยังไม่ส่ง → ไม่นับ");

  store.advance(q.quote_id, STATUS.SENT);
  assert.equal(eligibleQuotes(store, USER, () => clock).length, 1);

  clock = new Date("2026-09-30T10:00:00Z");
  assert.equal(eligibleQuotes(store, USER, () => clock).length, 0, "หมดอายุแล้ว → ไม่นับ");
});

test("คำถามยืนยันหมดอายุใน 10 นาที", () => {
  let t = 0;
  const w = createSlipWaiters({ now: () => t });
  w.ask("room", { mediaId: "m1", quotes: ["Q-20260916-001"] });

  t = CONFIRM_TTL_MS - 1;
  assert.ok(w.pending("room"), "ก่อนครบ 10 นาทียังตอบได้");

  t = CONFIRM_TTL_MS;
  assert.equal(w.pending("room"), null, "เกิน 10 นาทีถือว่าไม่ตอบ");
});

test("คำถามที่หมดอายุถูกคืนมาให้ส่งรูปให้เจ้าของเป็นเคสทั่วไป", () => {
  let t = 0;
  const w = createSlipWaiters({ now: () => t });
  w.ask("a", { mediaId: "m1", quotes: ["Q-1"] });
  w.ask("b", { mediaId: "m2", quotes: ["Q-2"] });

  t = CONFIRM_TTL_MS;
  const expired = w.expired();
  assert.equal(expired.length, 2);
  assert.equal(w.size, 0, "คืนแล้วต้องไม่ค้างไว้ให้คืนซ้ำ");
  assert.equal(w.expired().length, 0);
});

/* ═══════════ ③ ที่เก็บรูป + ลิงก์ชั่วคราว ═══════════ */

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 1)]);

test("เก็บรูปโฟลเดอร์ 700 ไฟล์ 600 และ metadata ไม่มี userId เต็ม", () => {
  const media = createMediaStore({ dir: tmp("slips") });
  const meta = media.save(JPEG, { chatSuffix: "abcd", quoteId: "Q-20260916-001" });

  assert.equal(meta.type, "image/jpeg");
  assert.equal(fs.statSync(media.dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(media.dir, `${meta.id}.jpg`)).mode & 0o777, 0o600);

  const raw = fs.readFileSync(path.join(media.dir, `${meta.id}.json`), "utf8");
  assert.ok(!raw.includes(USER));
  assert.ok(raw.includes("abcd"));
});

test("ไฟล์ที่ไม่ใช่รูป → ไม่รับ", () => {
  const media = createMediaStore({ dir: tmp("slips") });
  assert.equal(media.save(Buffer.from("ไม่ใช่รูป")), null);
  assert.equal(media.save(Buffer.from("%PDF-1.4")), null);
});

test("ลิงก์รูปหมดอายุ · ลายเซ็นผิด · ดึงเกินเพดาน → ปฏิเสธหมด", () => {
  let t = Date.parse("2026-09-16T10:00:00Z");
  const media = createMediaStore({ dir: tmp("slips"), now: () => new Date(t) });
  const meta = media.save(JPEG);

  const parse = (p) => {
    const q = new URLSearchParams(p.split("?")[1]);
    return { expires: q.get("e"), signature: q.get("s") };
  };

  const good = parse(media.signedPath(meta.id));
  assert.equal(media.resolve(meta.id, { ...good, signature: "ปลอม" }).ok, false, "ลายเซ็นผิดต้องไม่ผ่าน");
  assert.equal(media.resolve(meta.id, good).ok, true);

  /* ดึงได้อีก 3 ครั้ง (รวม 4) แล้วต้องตาย */
  assert.equal(media.resolve(meta.id, good).ok, true);
  assert.equal(media.resolve(meta.id, good).ok, true);
  assert.equal(media.resolve(meta.id, good).ok, true);
  assert.equal(media.resolve(meta.id, good).ok, false, "ดึงครบเพดานแล้วต้องปิด");

  const fresh = parse(media.signedPath(meta.id));
  t += 6 * 60 * 1000;
  assert.equal(media.resolve(meta.id, fresh).reason, "expired", "เกิน 5 นาทีต้องหมดอายุ");
});

test("ปิดลิงก์ได้ทันทีหลังส่ง", () => {
  const media = createMediaStore({ dir: tmp("slips") });
  const meta = media.save(JPEG);
  const q = new URLSearchParams(media.signedPath(meta.id).split("?")[1]);
  media.revoke(meta.id);
  assert.equal(media.resolve(meta.id, { expires: q.get("e"), signature: q.get("s") }).reason, "revoked");
});

test("ลบรูปที่เกิน 30 วัน ทั้งไฟล์ภาพและ metadata", () => {
  let t = Date.parse("2026-08-01T00:00:00Z");
  const media = createMediaStore({ dir: tmp("slips"), now: () => new Date(t) });
  const old = media.save(JPEG);
  t = Date.parse("2026-09-16T00:00:00Z");
  const recent = media.save(JPEG);

  assert.equal(media.sweep({ days: 30 }), 1);
  assert.equal(fs.existsSync(path.join(media.dir, `${old.id}.jpg`)), false);
  assert.equal(fs.existsSync(path.join(media.dir, `${old.id}.json`)), false);
  assert.equal(fs.existsSync(path.join(media.dir, `${recent.id}.jpg`)), true);
});

/* ═══════════ ④ incident log ═══════════ */

test("incident เก็บครบ 6 อย่างที่เจ้าของร้านต้องรู้ และไม่มี PII เกินจำเป็น", () => {
  const log = createIncidentLog({ dir: tmp("incidents"), log: quiet });
  const rec = log.record({ chatId: USER, failure: "model", retry: "ไม่สำเร็จทั้ง 2 ครั้ง", fallback: "ตอบข้อความกลาง ๆ" });

  assert.match(rec.at, /\+07:00$/);
  assert.equal(rec.suffix, "abcd");
  assert.equal(rec.failure, "model");
  assert.equal(rec.failure_label, FAILURE_CLASSES.model.label);
  assert.ok(rec.retry && rec.fallback && rec.next_action, "ต้องมีครบทั้ง retry · fallback · next action");

  const raw = fs.readFileSync(path.join(log.dir, `${bangkokDate()}.jsonl`), "utf8");
  assert.ok(!raw.includes(USER), "ห้ามมี userId เต็ม");
});

test("failure class ที่ไม่รู้จัก → unknown ไม่พัง", () => {
  const log = createIncidentLog({ dir: tmp("incidents"), log: quiet });
  assert.equal(log.record({ chatId: USER, failure: "อะไรไม่รู้" }).failure, "unknown");
});

test("มี failure class ครบ 5 แบบที่ต้องทดสอบ", () => {
  for (const f of ["line_api", "model", "timeout", "reply_token", "brain"]) {
    assert.ok(FAILURE_CLASSES[f], `ขาด failure class: ${f}`);
    assert.ok(FAILURE_CLASSES[f].next, `${f} ต้องบอกว่าเจ้าของร้านต้องทำอะไรต่อ`);
  }
});

/* ═══════════ ④ fault injection ═══════════ */

const faultRig = (env = { ALLOW_FAULT_INJECTION: "1" }) => {
  const claims = createAdminClaims({ dir: tmp("admin") });
  let t = 0;
  const box = createFaultBox({ claims, env, now: () => t });
  return { claims, box, tick: (ms) => { t += ms; } };
};

test("ค่าเริ่มต้นคือปิด และมี fault ครบ 5 แบบ", () => {
  const { box } = faultRig();
  assert.deepEqual(Object.keys(FAULTS), ["line_api", "model", "timeout", "reply_token", "brain"]);
  for (const f of Object.keys(FAULTS)) assert.equal(box.active(f), false);
});

test("ไม่ตั้ง ALLOW_FAULT_INJECTION → เปิดไม่ได้เลย", () => {
  const { box } = faultRig({});
  const res = box.enable("model");
  assert.equal(res.ok, false);
  assert.match(res.reason, /ALLOW_FAULT_INJECTION/);
  assert.equal(box.active("model"), false);
});

test("เปิดได้ทีละแบบเท่านั้น", () => {
  const { box } = faultRig();
  box.enable("model");
  assert.equal(box.active("model"), true);

  box.enable("timeout");
  assert.equal(box.active("timeout"), true);
  assert.equal(box.active("model"), false, "เปิดตัวใหม่ = ตัวเก่าปิด");
});

test("ดับเองใน 5 นาที ต่อให้ลืมปิด", () => {
  const { box, tick } = faultRig();
  box.enable("line_api");
  tick(FAULT_TTL_MS - 1);
  assert.equal(box.active("line_api"), true);
  tick(1);
  assert.equal(box.active("line_api"), false);
});

test("มีแอดมิน claim อยู่ = โหมดใช้งานจริง → เปิดไม่ได้ และที่เปิดค้างอยู่ต้องดับทันที", () => {
  const { box, claims } = faultRig();
  box.enable("model");
  assert.equal(box.active("model"), true);

  claims.claim(claims.issue().code, OWNER);
  assert.equal(box.active("model"), false, "claim แล้วของที่เปิดค้างต้องดับทันที ไม่ต้องรอหมดเวลา");
  assert.equal(box.enable("model").ok, false);
  assert.match(box.status().blockedByAdmin ? "blocked" : "", /blocked/);
});

test("fault ที่ไม่รู้จัก → ปฏิเสธ", () => {
  const { box } = faultRig();
  assert.equal(box.enable("ระเบิดเลย").ok, false);
});

/* ═══════════ ④ คำพูดที่ลูกค้าเห็น ═══════════ */

test("ข้อความกู้เหตุทุกข้อความไม่มีศัพท์ระบบ", async () => {
  const safe = await import("../src/safe-reply.js");
  const slip = await import("../src/slip-flow.js");
  const texts = [safe.SLOW_REPLY, safe.HANDOFF_REPLY, safe.RECOVERED_REPLY, slip.NEUTRAL_IMAGE_REPLY];
  for (const t of texts) {
    assert.ok(!hasSystemTerms(t), `มีศัพท์ระบบหลุด: ${t}`);
    assert.match(t, /(คะ|ค่ะ)$/, `ต้องลงท้ายสุภาพ: ${t}`);
  }
});
