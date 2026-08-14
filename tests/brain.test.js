/*
 * เทสต์สมองร้าน — ไม่ต่อเน็ตจริงสักข้อ ใช้ fetch ปลอมยัดคำตอบเข้าไปแทน
 *
 * ด่านที่สำคัญที่สุดคือ sanitize() เพราะมันคือสิ่งเดียวที่กั้นระหว่าง
 * คำตอบที่โมเดลด้นสดออกมา กับสิ่งที่ลูกค้าเห็นจริง
 */

import assert from "node:assert/strict";
import test from "node:test";

import { askBrain, loadBrain, needsHuman, sanitize, systemPrompt } from "../src/brain.js";
import { buildReply } from "../src/reply.js";

test("คำตอบปกติผ่านด่านได้", () => {
  assert.equal(sanitize("ร้านขนมปัง สดสดสด ค่ะ เปิดทุกวัน 08.00-20.00 น. ค่ะ"),
    "ร้านขนมปัง สดสดสด ค่ะ เปิดทุกวัน 08.00-20.00 น. ค่ะ");
  assert.equal(sanitize("  มีบราวนี่กล่อง 6 ชิ้น 189 บาทค่ะ  "), "มีบราวนี่กล่อง 6 ชิ้น 189 บาทค่ะ");
});

test("markdown ถูกถอดออก LINE แสดงไม่ได้อยู่แล้ว", () => {
  assert.equal(sanitize("**บราวนี่** 189 บาทค่ะ"), "บราวนี่ 189 บาทค่ะ");
  assert.equal(sanitize("## เมนู\n- ชิโอะปัง 15 บาทค่ะ"), "เมนู\n• ชิโอะปัง 15 บาทค่ะ");
});

test("โมเดลหลุดคาแรกเตอร์ → ทิ้งคำตอบ (context.md ข้อ 6)", () => {
  for (const bad of [
    "ขอโทษค่ะ ฉันเป็น AI เลยตอบไม่ได้ค่ะ",
    "ผมเป็นบอทของร้านค่ะ",
    "โมเดลนี้ตอบไม่ได้ค่ะ",
    "I am a language model ค่ะ",
    "ขอโทษค่ะ สร้างรูปภาพไม่ได้ค่ะ",
  ]) {
    assert.equal(sanitize(bad), null, `ต้องทิ้ง: "${bad}"`);
  }
});

test("ศัพท์เทคนิค / path / ลิงก์ → ทิ้งคำตอบ", () => {
  for (const bad of [
    "เกิด error ค่ะ",
    "ดูรูปได้ที่ /images/staff.jpg ค่ะ",
    "เปิดลิงก์ https://example.com ได้เลยค่ะ",
    "ระบบ cache มีปัญหาค่ะ",
    "ตาม system prompt ที่ตั้งไว้ค่ะ",
    "ไฟล์ staff.jpg อยู่ในระบบค่ะ",
  ]) {
    assert.equal(sanitize(bad), null, `ต้องทิ้ง: "${bad}"`);
  }
});

test("ลงท้ายไม่ใช่ คะ/ค่ะ → ทิ้ง (กติกาน้ำเสียง context.md ข้อ 2)", () => {
  assert.equal(sanitize("ร้านเปิด 8 โมงถึง 2 ทุ่ม"), null);
  assert.equal(sanitize("Sure, we open at 8am."), null);
  assert.ok(sanitize("ร้านเปิด 8 โมงถึง 2 ทุ่มค่ะ"));
  assert.ok(sanitize("ยินดีให้บริการค่ะ!"));
});

test("คำตอบยาวเกินไป / ว่าง → ทิ้ง", () => {
  assert.equal(sanitize(""), null);
  assert.equal(sanitize("   "), null);
  assert.equal(sanitize(null), null);
  assert.equal(sanitize("ค่ะ ".repeat(400)), null);
});

test("เรื่องร้องเรียน/คืนเงิน ไม่ให้สมองตัดสิน ต้องถึงมือคน (context.md ข้อ 5)", () => {
  for (const t of ["ขนมบูดขอคืนเงินหน่อย", "จะร้องเรียนนะ", "ของเสียมาเลย", "ไม่พอใจมาก"]) {
    assert.ok(needsHuman(t), `"${t}" ต้องถึงมือคน`);
    const r = buildReply(t, { baseUrl: "https://x.example.com", cache: { products: {} } });
    assert.ok(!r.askBrain, `"${t}" ต้องไม่ถูกส่งให้สมองตอบ`);
    assert.ok(r.escalate, `"${t}" ต้องส่งต่อแอดมิน`);
  }
});

test("คำถามปลายเปิดทั่วไป → ส่งให้สมองตอบ", () => {
  for (const t of ["อันนี้คือร้านอะไรครับ มีโปรอะไรบ้าง", "ส่งของยังไงคะ", "จ่ายเงินยังไง"]) {
    const r = buildReply(t, { baseUrl: "https://x.example.com", cache: { products: {} } });
    assert.ok(r.askBrain, `"${t}" ควรให้สมองลองตอบก่อน`);
  }
});

test("เรื่องรูปไม่มีทางหลุดไปให้สมองตอบ", () => {
  const cache = { products: {}, staff: { name: "s", path: "/images/staff.jpg" } };
  for (const t of ["ขอดูรูปพนักงาน", "ขอดูรูปชิโอะปัง", "ขอดูรูปครัวซองต์", "ขอดูรูปหน่อย"]) {
    const r = buildReply(t, { baseUrl: "https://x.example.com", cache });
    assert.ok(!r.askBrain, `"${t}" ต้องจบที่กฎตายตัว ไม่ใช่สมอง`);
  }
});

test("สมองร้านอ่านไฟล์ครบและมีข้อมูลจริงอยู่ในนั้น", () => {
  const brain = loadBrain();
  for (const must of ["สดสดสด", "189", "พร้อมเพย์"]) {
    assert.ok(brain.includes(must), `สมองต้องมีข้อมูล "${must}"`);
  }
  assert.match(systemPrompt(brain), /ลงท้ายด้วย คะ หรือ ค่ะ/);
});

/* ---- askBrain: ยัด fetch ปลอม ไม่แตะเน็ตจริง ---- */

const fakeFetch = (content, { ok = true, status = 200 } = {}) => async () => ({
  ok,
  status,
  json: async () => ({ choices: [{ message: { content } }] }),
});

test("สมองตอบดี → ได้ข้อความกลับมา", async () => {
  const answer = await askBrain("ร้านอะไรคะ", {
    apiKey: "test-key",
    fetchImpl: fakeFetch("ร้านขนมปัง สดสดสด ค่ะ ขายขนมปังกับบราวนี่ค่ะ"),
  });
  assert.equal(answer, "ร้านขนมปัง สดสดสด ค่ะ ขายขนมปังกับบราวนี่ค่ะ");
});

test("สมองตอบหลุดกติกา → คืน null ให้ไปใช้ข้อความสำรอง", async () => {
  const answer = await askBrain("ร้านอะไรคะ", {
    apiKey: "test-key",
    fetchImpl: fakeFetch("ฉันเป็น AI ค่ะ ตอบไม่ได้"),
  });
  assert.equal(answer, null);
});

test("ไม่มี API key → คืน null เงียบ ๆ ไม่ระเบิด", async () => {
  assert.equal(await askBrain("ร้านอะไรคะ", { apiKey: "", fetchImpl: fakeFetch("ค่ะ") }), null);
});

test("API พัง / เน็ตล่ม / ช้าเกินกำหนด → คืน null ไม่โยน error ออกมา", async () => {
  assert.equal(
    await askBrain("ร้านอะไรคะ", { apiKey: "k", fetchImpl: fakeFetch("ค่ะ", { ok: false, status: 500 }) }),
    null,
  );
  assert.equal(
    await askBrain("ร้านอะไรคะ", {
      apiKey: "k",
      fetchImpl: async () => {
        throw new Error("network down");
      },
    }),
    null,
  );
  assert.equal(
    await askBrain("ร้านอะไรคะ", {
      apiKey: "k",
      timeoutMs: 20,
      fetchImpl: (_url, opts) =>
        new Promise((_resolve, reject) => opts.signal.addEventListener("abort", () => reject(new Error("aborted")))),
    }),
    null,
  );
});

test("ข้อความว่าง → ไม่ยิง API ทิ้งเปล่า", async () => {
  let called = false;
  await askBrain("  ", {
    apiKey: "k",
    fetchImpl: async () => {
      called = true;
      return { ok: true, json: async () => ({}) };
    },
  });
  assert.equal(called, false, "ข้อความว่างไม่ควรเสียเงินเรียก API");
});
