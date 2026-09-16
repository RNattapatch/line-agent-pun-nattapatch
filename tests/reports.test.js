/*
 * เทสต์เส้นทางส่งรายงาน 4 งาน — ก่อน claim · หลัง claim · หลัง revoke
 *
 * ข้อที่ห้ามพลาดที่สุด: ของที่ค้างคิวไว้ตอนยังไม่มีแอดมิน ต้องไหลเข้ามาให้ครบตอน claim
 * รายงานที่หายไปเงียบ ๆ คือรายงานที่ไม่มีใครรู้ว่าเคยมี — แย่กว่ารายงานที่มาช้า
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAdminClaims } from "../src/admin-claim.js";
import { REPORT_JOBS, createReports, isReportJob } from "../src/reports.js";

const OWNER = "Uเจ้าของ000000000000000000000001";
const quiet = { log() {}, warn() {}, error() {} };

function rig({ pushFails = false } = {}) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "reports-test-")), "admin");
  const claims = createAdminClaims({ dir });
  const sent = [];
  const reports = createReports({
    dir,
    claims,
    log: quiet,
    push: async (args) => {
      if (pushFails) throw new Error("LINE ล่ม");
      sent.push(args);
    },
  });
  const becomeAdmin = () => claims.claim(claims.issue().code, OWNER);
  return { dir, claims, reports, sent, becomeAdmin };
}

const textsTo = (sent, to = OWNER) =>
  sent.filter((s) => s.to === to).flatMap((s) => s.messages).map((m) => m.text);

test("มีงานรายงานครบ 4 แบบตามโจทย์", () => {
  assert.deepEqual(Object.keys(REPORT_JOBS), ["evening", "urgent", "slip", "appointment"]);
  assert.deepEqual(
    Object.values(REPORT_JOBS).map((j) => j.label),
    ["รายงานเย็น", "แจ้งด่วน", "แจ้งสลิป", "แจ้งนัดใหม่"],
  );
  assert.equal(isReportJob("evening"), true);
  assert.equal(isReportJob("ไม่มีงานนี้"), false);
});

test("งานที่ไม่รู้จัก → โยน error ไม่ใช่ส่งเงียบ ๆ ไปไหนก็ไม่รู้", async () => {
  const { reports } = rig();
  await assert.rejects(() => reports.submit("ไม่มีงานนี้", "x"), TypeError);
});

/* ═══ ก่อน claim: deliver=local ═══ */

test("ยังไม่มีแอดมิน → deliver=local ไม่ยิงเข้าห้องไหนทั้งนั้น", async () => {
  const { reports, sent } = rig();

  assert.equal(reports.deliverMode(), "local");
  for (const job of Object.keys(REPORT_JOBS)) {
    assert.equal(await reports.submit(job, `ทดสอบ ${job}`), "local");
  }

  assert.equal(sent.length, 0, "ห้ามมีข้อความวิ่งออกไปหาใครเลย");
  assert.equal(reports.spoolSize(), 4, "แต่ต้องเก็บไว้ครบ");
});

test("คิวเก็บลงดิสก์ โฟลเดอร์ 700 ไฟล์ 600", async () => {
  const { reports, dir } = rig();
  await reports.submit("urgent", "ลับ");
  const spool = path.join(dir, "spool.jsonl");

  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(spool).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(spool, "utf8"), /ลับ/);
});

/* ═══ claim แล้วของค้างต้องไหลเข้ามาครบ ═══ */

test("claim แล้ว → ของที่ค้างคิวไหลเข้าแอดมินครบ ตามลำดับเดิม", async () => {
  const { reports, sent, becomeAdmin } = rig();

  await reports.submit("evening", "รายงานเย็นวันจันทร์");
  await reports.submit("urgent", "ลูกค้ารอตอบ");
  await reports.submit("slip", "ลูกค้าส่งสลิป");
  await reports.submit("appointment", "นัดรับของพรุ่งนี้");

  becomeAdmin();
  const { sent: n, left } = await reports.flush();

  assert.equal(n, 4, "ต้องส่งครบทั้ง 4 ชิ้น");
  assert.equal(left, 0);
  assert.equal(reports.spoolSize(), 0, "คิวต้องว่างหลังส่งครบ");

  const texts = textsTo(sent);
  assert.equal(texts.length, 4);
  assert.match(texts[0], /รายงานเย็นวันจันทร์/, "ลำดับต้องเหมือนตอนเข้าคิว");
  assert.match(texts[3], /นัดรับของพรุ่งนี้/);
  for (const t of texts) assert.match(t, /ค้างคิวไว้ตอนยังไม่มีแอดมิน/, "ต้องบอกว่าเป็นของค้าง");
});

test("หลัง claim → รายงานใหม่ถึงแอดมินทันที ไม่ผ่านคิว", async () => {
  const { reports, sent, becomeAdmin } = rig();
  becomeAdmin();

  assert.equal(reports.deliverMode(), "admin");
  assert.equal(await reports.submit("urgent", "ด่วนมาก"), "admin");

  assert.equal(reports.spoolSize(), 0);
  assert.match(textsTo(sent)[0], /🔔 แจ้งด่วน .* น\.\nด่วนมาก/, "มีหัวข้อบอกว่างานไหนและเวลาเท่าไหร่");
});

test("ยิงครบทั้ง 4 งานหลัง claim → แอดมินได้ครบ แยกหัวข้อได้", async () => {
  const { reports, sent, becomeAdmin } = rig();
  becomeAdmin();

  for (const job of Object.keys(REPORT_JOBS)) await reports.submit(job, `[ข้อความจำลอง] ${job}`);

  const texts = textsTo(sent);
  assert.equal(texts.length, 4);
  for (const job of Object.values(REPORT_JOBS)) {
    assert.ok(texts.some((t) => t.startsWith(`${job.icon} ${job.label}`)), `ขาดงาน: ${job.label}`);
  }
});

/* ═══ ส่งไม่ผ่านต้องไม่หาย ═══ */

test("push ไม่ผ่าน → ของกลับเข้าคิว ไม่หายไปพร้อม error", async () => {
  const { reports, becomeAdmin } = rig({ pushFails: true });
  becomeAdmin();

  assert.equal(await reports.submit("urgent", "ต้องไม่หาย"), "local");
  assert.equal(reports.spoolSize(), 1, "ส่งไม่ได้ต้องเก็บไว้ ไม่ใช่ทิ้ง");
});

test("เท flush ไม่ผ่านกลางคัน → หยุดตรงนั้น เก็บที่เหลือไว้ ไม่ข้ามลำดับ", async () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "reports-test-")), "admin");
  const claims = createAdminClaims({ dir });
  let allowed = 2;
  const sent = [];
  const reports = createReports({
    dir,
    claims,
    log: quiet,
    push: async (args) => {
      if (allowed-- <= 0) throw new Error("LINE ล่มกลางคัน");
      sent.push(args);
    },
  });

  for (const job of Object.keys(REPORT_JOBS)) await reports.submit(job, job);
  claims.claim(claims.issue().code, OWNER);

  const res = await reports.flush();
  assert.equal(res.sent, 2);
  assert.equal(res.left, 2, "ที่เหลือต้องยังอยู่ในคิว รอรอบหน้า");

  allowed = 10;
  assert.equal((await reports.flush()).sent, 2, "รอบหน้าส่งต่อจากเดิมได้");
  assert.deepEqual(textsTo(sent).map((t) => t.split("\n")[1]), ["evening", "urgent", "slip", "appointment"]);
});

/* ═══ revoke แล้วกลับเป็น local ═══ */

test("revoke → deliver กลับเป็น local และรายงานใหม่เข้าคิวแทน", async () => {
  const { reports, claims, sent, becomeAdmin } = rig();
  becomeAdmin();
  await reports.submit("urgent", "ตอนยังเป็นแอดมิน");
  assert.equal(sent.length, 1);

  claims.revoke();

  assert.equal(reports.deliverMode(), "local");
  assert.equal(await reports.submit("evening", "หลังถอนสิทธิ์"), "local");
  assert.equal(sent.length, 1, "ห้ามมีอะไรวิ่งไปหาคนที่โดนถอนสิทธิ์แล้ว");
  assert.equal(reports.spoolSize(), 1);
});

test("flush ตอนไม่มีแอดมิน → ไม่ส่งอะไรเลย และไม่ล้างคิวทิ้ง", async () => {
  const { reports, sent } = rig();
  await reports.submit("urgent", "ต้องอยู่ในคิวต่อไป");

  const res = await reports.flush();
  assert.equal(res.sent, 0);
  assert.equal(sent.length, 0);
  assert.equal(reports.spoolSize(), 1, "ห้ามล้างคิวทิ้งตอนไม่มีปลายทาง");
});

test("claim ใหม่หลัง revoke → ของที่ค้างช่วงไม่มีแอดมินไหลเข้าคนใหม่ครบ", async () => {
  const { reports, claims, sent, becomeAdmin } = rig();
  becomeAdmin();
  claims.revoke();

  await reports.submit("evening", "ค้างตอนไม่มีแอดมิน 1");
  await reports.submit("slip", "ค้างตอนไม่มีแอดมิน 2");

  claims.claim(claims.issue().code, OWNER);
  await reports.flush();

  assert.equal(textsTo(sent).length, 2);
  assert.equal(reports.spoolSize(), 0);
});
