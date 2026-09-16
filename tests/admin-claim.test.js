/*
 * เทสต์การยกสิทธิ์ผู้ดูแล — รหัสใช้ครั้งเดียว · TTL · revoke
 *
 * ไม่มีรหัสตายตัวเขียนอยู่ในไฟล์นี้เลยแม้แต่ตัวเดียว ทุกรหัสถูกสร้างตอนรัน
 * (ถ้าเขียนรหัสไว้ในเทสต์ รหัสนั้นจะขึ้น GitHub ทันทีที่ commit — ข้อบังคับข้อ 5)
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CLAIM,
  CODE_LENGTH,
  CODE_RE,
  TTL_MINUTES,
  base32,
  createAdminClaims,
  looksLikeCode,
  normalizeCode,
} from "../src/admin-claim.js";

const OWNER = "Uเจ้าของ000000000000000000000001";
const OTHER = "Uคนอื่น00000000000000000000000002";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "claim-test-"));
const fresh = (opts = {}) => createAdminClaims({ dir: path.join(tmp(), "admin"), ...opts });

/* ═══ รูปแบบรหัส ═══ */

test("รหัสเป็น base32 (RFC 4648) 32 ตัว = สุ่ม 160 บิต", () => {
  const claims = fresh();
  for (let i = 0; i < 20; i++) {
    const { code } = claims.issue();
    assert.equal(code.length, CODE_LENGTH);
    assert.match(code, CODE_RE);
    /* ตัวอักษรต้องอยู่ในชุด RFC 4648 เท่านั้น — ไม่มี 0 1 8 ที่สับสนกับ O I B ตอนพิมพ์ */
    assert.ok(!/[018]/.test(code), `มีตัวเลขที่สับสนกับตัวอักษร: ${code.replace(/./g, "•")}`);
  }
});

test("base32 แปลง 20 ไบต์เป็น 32 ตัวพอดี ไม่มีเศษให้ต้อง pad", () => {
  assert.equal(base32(Buffer.alloc(20, 0)), "A".repeat(32));
  assert.equal(base32(Buffer.alloc(20, 0xff)), "7".repeat(32));
  /* ค่ามาตรฐาน RFC 4648: "foobar" → MZXW6YTBOI */
  assert.equal(base32(Buffer.from("foobar", "utf8")), "MZXW6YTBOI");
});

test("รหัสไม่ซ้ำกันเลยใน 500 ใบ", () => {
  const claims = fresh();
  const seen = new Set();
  for (let i = 0; i < 500; i++) seen.add(claims.issue().code);
  assert.equal(seen.size, 500);
});

test("รับรหัสที่พิมพ์มาแบบมีเว้นวรรค ขีด หรือพิมพ์เล็ก", () => {
  const claims = fresh();
  const { code } = claims.issue();
  const spaced = code.match(/.{1,4}/g).join(" ").toLowerCase();

  assert.equal(normalizeCode(spaced), code);
  assert.equal(looksLikeCode(spaced), code, "พิมพ์ตามที่เห็นบนจอต้องใช้ได้");
  assert.equal(looksLikeCode(`claim ${code}`), code, "พิมพ์คำนำหน้ามาด้วยก็ยังอ่านออก");
  assert.equal(claims.claim(spaced, OWNER).result, CLAIM.OK);
});

test("ข้อความปกติของลูกค้าต้องไม่ถูกอ่านว่าเป็นรหัส", () => {
  for (const text of [
    "ขอใบเสนอราคา บราวนี่กล่อง 2 กล่อง",
    "สนใจค่ะ",
    "ABCDEFG",
    "0123456789012345678901234567890123",
    "",
    null,
  ]) {
    assert.equal(looksLikeCode(text), null, `ต้องไม่ใช่รหัส: ${text}`);
  }
});

/* ═══ เก็บเฉพาะ hash ═══ */

test("ไฟล์สถานะเก็บแค่ hash — ตัวรหัสไม่เคยแตะดิสก์", () => {
  const claims = fresh();
  const { code } = claims.issue();
  const raw = fs.readFileSync(path.join(claims.dir, "state.json"), "utf8");

  assert.ok(!raw.includes(code), "รหัสห้ามอยู่ในไฟล์");
  assert.ok(!raw.includes(code.slice(0, 8)), "แม้แต่เศษของรหัสก็ห้าม");
  assert.match(JSON.parse(raw).pending.hash, /^[0-9a-f]{64}$/, "เก็บ sha256");
  assert.equal(JSON.parse(raw).pending.algo, "sha256");
});

test("โฟลเดอร์ 700 ไฟล์ 600 — user อื่นบนเครื่องเดียวกันอ่านไม่ได้", () => {
  const claims = fresh();
  claims.issue();
  assert.equal(fs.statSync(claims.dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(claims.dir, "state.json")).mode & 0o777, 0o600);
});

test("ร่องรอยมีแต่เหตุการณ์ ไม่มีรหัสและไม่มี userId เต็ม", () => {
  const claims = fresh();
  const { code } = claims.issue();
  claims.claim(code, OWNER);
  claims.revoke();

  const raw = fs.readFileSync(path.join(claims.dir, "state.json"), "utf8");
  assert.ok(!raw.includes(code));
  assert.ok(!raw.includes(OWNER), "userId เต็มห้ามอยู่ในร่องรอย");
  assert.ok(raw.includes(OWNER.slice(-4)), "เก็บแค่ 4 ตัวท้ายพอให้ไล่ย้อนได้");
});

/* ═══ ใช้ครั้งเดียว · หมดอายุ · revoke ═══ */

test("รหัสถูก → เป็นแอดมินทันที", () => {
  const claims = fresh();
  assert.equal(claims.currentAdmin(), null);

  const { code } = claims.issue();
  assert.equal(claims.claim(code, OWNER).result, CLAIM.OK);

  assert.equal(claims.currentAdmin(), OWNER);
  assert.equal(claims.isAdmin(OWNER), true);
  assert.equal(claims.isAdmin(OTHER), false);
});

test("ใช้รหัสเดิมซ้ำ → replay ไม่ผ่าน และไม่เปลี่ยนตัวแอดมิน", () => {
  const claims = fresh();
  const { code } = claims.issue();
  claims.claim(code, OWNER);

  assert.equal(claims.claim(code, OTHER).result, CLAIM.REPLAY);
  assert.equal(claims.currentAdmin(), OWNER, "คนที่มาทีหลังต้องแย่งสิทธิ์ไม่ได้");
});

test(`รหัสหมดอายุใน ${TTL_MINUTES} นาที`, () => {
  let clock = new Date("2026-09-16T10:00:00.000Z");
  const claims = fresh({ now: () => clock });
  const { code } = claims.issue();

  clock = new Date(clock.getTime() + (TTL_MINUTES - 1) * 60_000);
  const claimsB = createAdminClaims({ dir: claims.dir, now: () => clock });
  assert.equal(claimsB.status().pendingCode !== null, true, "ก่อนครบเวลายังใช้ได้");

  clock = new Date(clock.getTime() + 2 * 60_000); // เลย TTL ไปแล้ว
  const claimsC = createAdminClaims({ dir: claims.dir, now: () => clock });
  assert.equal(claimsC.claim(code, OWNER).result, CLAIM.EXPIRED);
  assert.equal(claimsC.currentAdmin(), null);
});

test("รหัสมั่ว → invalid และไม่บอกว่าใกล้เคียงแค่ไหน", () => {
  const claims = fresh();
  const { code } = claims.issue();

  /* เปลี่ยนตัวสุดท้ายไป 1 ตัว — ต้องได้ผลเหมือนรหัสที่ไม่มีอยู่จริงเลย */
  const nearMiss = code.slice(0, -1) + (code.at(-1) === "A" ? "B" : "A");
  assert.equal(claims.claim(nearMiss, OWNER).result, CLAIM.INVALID);
  assert.equal(claims.claim(base32(crypto.randomBytes(20)), OWNER).result, CLAIM.INVALID);
  assert.equal(claims.claim("", OWNER).result, CLAIM.INVALID);
  assert.equal(claims.currentAdmin(), null);
});

test("ยังไม่เคยออกรหัส → claim อะไรก็ไม่ผ่าน", () => {
  const claims = fresh();
  assert.equal(claims.claim(base32(crypto.randomBytes(20)), OWNER).result, CLAIM.INVALID);
});

test("ออกรหัสใหม่ → รหัสเก่าตายทันที", () => {
  const claims = fresh();
  const first = claims.issue().code;
  claims.issue();

  assert.equal(claims.claim(first, OWNER).result, CLAIM.INVALID, "รหัสที่ออกไว้แล้วลืมยกเลิกต้องใช้ไม่ได้");
});

test("revoke → กลับเป็นไม่มีแอดมิน และรหัสที่ค้างอยู่ตายไปด้วย", () => {
  const claims = fresh();
  const { code } = claims.issue();
  claims.claim(code, OWNER);

  const spare = claims.issue().code; // ออกไว้ก่อน revoke
  claims.revoke();

  assert.equal(claims.currentAdmin(), null);
  assert.equal(claims.isAdmin(OWNER), false, "บัญชีเดิมกลับเป็นลูกค้า");

  /*
   * ทั้งสองใบต้องถูกปฏิเสธ แต่คนละเหตุ และทั้งคู่ถูกต้อง:
   *   spare = ใบที่ยัง pending ตอน revoke → โดนทำเป็น "ใช้แล้ว" ไปด้วย → replay
   *   code  = ใบเก่าที่หลุดจาก pending ไปตั้งแต่ตอนออก spare → invalid
   * ที่สำคัญคือไม่มีใบไหน claim ผ่าน และไม่มีใบไหนพาแอดมินกลับมา
   */
  assert.equal(claims.claim(spare, OWNER).result, CLAIM.REPLAY, "รหัสที่ค้างอยู่ตอน revoke ต้อง claim กลับไม่ได้");
  assert.equal(claims.claim(code, OWNER).result, CLAIM.INVALID, "รหัสที่ถูกใบใหม่แทนที่ไปแล้วก็ใช้ไม่ได้");
  assert.equal(claims.currentAdmin(), null, "ไม่มีรหัสเก่าใบไหนพาสิทธิ์กลับมาได้");
});

test("revoke ตอนไม่มีแอดมิน → ไม่พัง สั่งซ้ำได้", () => {
  const claims = fresh();
  assert.equal(claims.revoke().had, false);
  assert.equal(claims.revoke().had, false);
});

test("claim ใหม่หลัง revoke ได้ และเปลี่ยนตัวแอดมินได้", () => {
  const claims = fresh();
  claims.claim(claims.issue().code, OWNER);
  claims.revoke();

  assert.equal(claims.claim(claims.issue().code, OTHER).result, CLAIM.OK);
  assert.equal(claims.currentAdmin(), OTHER);
  assert.equal(claims.isAdmin(OWNER), false);
});

test("ไม่รู้ว่าใครส่งมา (ไม่มี LINE user id) → ไม่ยกสิทธิ์ให้", () => {
  const claims = fresh();
  const { code } = claims.issue();
  assert.equal(claims.claim(code, null).result, CLAIM.INVALID);
  assert.equal(claims.currentAdmin(), null);
});

test("สถานะที่เครื่องมือผู้ดูแลแสดง ไม่มีรหัสและไม่มี userId เต็ม", () => {
  const claims = fresh();
  claims.issue();
  claims.claim(claims.issue().code, OWNER);

  const s = claims.status();
  const dump = JSON.stringify(s);
  assert.equal(s.hasAdmin, true);
  assert.equal(s.adminSuffix, OWNER.slice(-4));
  assert.ok(!dump.includes(OWNER), "ห้ามมี userId เต็ม");
  assert.ok(!CODE_RE.test(dump), "ห้ามมีรหัส");
});

test("อ่านสถานะใหม่จากดิสก์ทุกครั้ง — เครื่องมือผู้ดูแลกับเซิร์ฟเวอร์เป็นคนละ process", () => {
  const claims = fresh();
  const server = createAdminClaims({ dir: claims.dir }); // จำลองอีก process ที่เปิดค้างไว้

  claims.claim(claims.issue().code, OWNER);
  assert.equal(server.isAdmin(OWNER), true, "เซิร์ฟเวอร์ต้องเห็นว่ามีคน claim แล้ว");

  claims.revoke();
  assert.equal(server.isAdmin(OWNER), false, "และต้องเห็นตอนโดน revoke ทันที ไม่ต้องรีสตาร์ต");
});
