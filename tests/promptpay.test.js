/*
 * เทสต์ payload พร้อมเพย์ — ตัวเลขผิดที่นี่คือเงินลูกค้าโอนไปผิดที่หรือผิดยอด
 * เอาคืนไม่ได้ จึงเทสต์ทั้งรูปแบบเบอร์ CRC และเคสที่ต้องปฏิเสธ
 */

import assert from "node:assert/strict";
import test from "node:test";

import { crc16, promptPayPayload, toPromptPayTarget } from "../src/promptpay.js";

test("แปลงเบอร์ไทยเป็นรูปแบบพร้อมเพย์ 13 หลัก", () => {
  assert.equal(toPromptPayTarget("080-000-0000"), "0066800000000");
  assert.equal(toPromptPayTarget("0800000000"), "0066800000000");
  assert.equal(toPromptPayTarget("66800000000"), "0066800000000");
  assert.equal(toPromptPayTarget("+66 80 000 0000"), "0066800000000");
});

test("เบอร์ที่ไม่ถูกต้อง → null ไม่เดา", () => {
  for (const bad of ["", null, "12345", "080-000-00001234", "ไม่ใช่เบอร์"]) {
    assert.equal(toPromptPayTarget(bad), null, `ต้องปฏิเสธ: ${bad}`);
  }
});

test("CRC-16/CCITT-FALSE ตรงกับค่ามาตรฐาน", () => {
  /* ค่าทดสอบมาตรฐานของ CRC-16/CCITT-FALSE คือ 29B1 สำหรับ "123456789" */
  assert.equal(crc16("123456789"), "29B1");
});

test("payload มีครบทุกช่องที่ EMVCo บังคับ และลงท้ายด้วย CRC ที่ถูกต้อง", () => {
  const payload = promptPayPayload({ phone: "080-000-0000", amount: 189 });

  assert.match(payload, /^000201/, "ช่อง payload format indicator");
  assert.match(payload, /010212/, "ใช้ครั้งเดียว ไม่ใช่ QR ถาวรของร้าน");
  assert.match(payload, /A000000677010111/, "รหัสพร้อมเพย์");
  assert.match(payload, /01130066800000000/, "เบอร์ปลายทาง 13 หลัก");
  assert.match(payload, /5303764/, "สกุลเงินบาท");
  assert.match(payload, /5406189\.00/, "ยอดต้องมีทศนิยม 2 ตำแหน่งเสมอ");
  assert.match(payload, /5802TH/);

  const body = payload.slice(0, -4);
  assert.equal(payload.slice(-4), crc16(body), "CRC ต้องคิดรวมหัวช่อง 6304 ด้วย");
});

test("ยอดที่ใช้ไม่ได้ → ไม่ออก payload (ห้ามมี QR ปลายเปิดหลุดออกจากใบเสนอราคา)", () => {
  for (const amount of [0, -1, null, undefined, NaN, "ไม่ใช่ตัวเลข"]) {
    assert.equal(promptPayPayload({ phone: "080-000-0000", amount }), null, `ต้องปฏิเสธยอด: ${amount}`);
  }
  assert.equal(promptPayPayload({ phone: null, amount: 100 }), null);
});
