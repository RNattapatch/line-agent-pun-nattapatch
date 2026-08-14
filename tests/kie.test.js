/*
 * เทสต์ตัวต่อ kie.ai — เน้นสองเรื่องที่พังแล้วเจ็บ:
 *   1. kie.ai ล่ม/ตอบมั่ว ต้องได้ Error ที่อ่านรู้เรื่อง ไม่ใช่ค้างหรือ crash แปลก ๆ
 *   2. API key ต้องไม่หลุดออกมากับข้อความ error (repo นี้เป็น public)
 *
 * ไม่ยิง API จริง — สลับ global.fetch เป็นของปลอมทั้งหมด รันฟรีและไม่กินเครดิต
 */

import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";

import { createTask, generateImage, pollTask, redact } from "../src/kie.js";

const FAKE_KEY = "sk-fake-key-for-tests-only";
const realFetch = global.fetch;

beforeEach(() => {
  process.env.KIE_API_KEY = FAKE_KEY;
});

afterEach(() => {
  global.fetch = realFetch;
});

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("ไม่มี KIE_API_KEY → บอกให้ไปเติมใน .env", async () => {
  delete process.env.KIE_API_KEY;
  global.fetch = () => assert.fail("ไม่ควรยิง API เลยเมื่อไม่มี key");

  await assert.rejects(() => createTask("test"), /KIE_API_KEY/);
});

test("kie.ai ล่ม (500 + หน้า HTML) → Error ที่อ่านรู้เรื่อง ไม่ใช่ JSON parse error ดิบ ๆ", async () => {
  global.fetch = async () => new Response("<html>502 Bad Gateway</html>", { status: 502 });

  await assert.rejects(() => createTask("test"), /ไม่ใช่ JSON/);
});

test("key ผิด (401) → Error บอกสถานะ และต้องไม่มี key ติดไปด้วย", async () => {
  global.fetch = async () => jsonResponse({ code: 401, msg: "Unauthorized" }, 401);

  await assert.rejects(
    () => createTask("test"),
    (err) => {
      assert.match(err.message, /401/);
      assert.ok(!err.message.includes(FAKE_KEY), "API key หลุดมากับข้อความ error");
      return true;
    },
  );
});

test("เครดิตหมด (402) → ไม่เงียบ ต้องโยน Error ออกมา", async () => {
  global.fetch = async () => jsonResponse({ code: 402, msg: "Insufficient credits" }, 402);

  await assert.rejects(() => createTask("test"), /402/);
});

test("task fail ระหว่างสร้าง → บอกสาเหตุที่ kie.ai ส่งกลับมา", async () => {
  global.fetch = async (url) =>
    String(url).includes("createTask")
      ? jsonResponse({ code: 200, data: { taskId: "t1" } })
      : jsonResponse({ code: 200, data: { state: "fail", failMsg: "content policy" } });

  await assert.rejects(() => generateImage("test"), /content policy/);
});

test("task สำเร็จ → คืน URL กับจำนวนเครดิตที่ใช้", async () => {
  global.fetch = async (url) =>
    String(url).includes("createTask")
      ? jsonResponse({ code: 200, data: { taskId: "t1" } })
      : jsonResponse({
          code: 200,
          data: {
            state: "success",
            resultJson: JSON.stringify({ resultUrls: ["https://cdn.example.com/a.jpg"] }),
            creditsConsumed: 4,
          },
        });

  const result = await generateImage("test");
  assert.equal(result.url, "https://cdn.example.com/a.jpg");
  assert.equal(result.credits, 4);
});

test("task ค้างไม่เสร็จ → เลิกรอตามเวลาที่กำหนด ไม่ค้างตลอดกาล", async () => {
  global.fetch = async () => jsonResponse({ code: 200, data: { state: "generating", progress: 40 } });

  await assert.rejects(() => pollTask("t1", { intervalMs: 1, timeoutMs: 30 }), /ไม่เสร็จภายใน/);
});

test("redact() ลบ key ออกจากข้อความทุกที่ที่โผล่", () => {
  const leaky = `Bearer ${FAKE_KEY} failed, retry with ${FAKE_KEY}`;
  const cleaned = redact(leaky);

  assert.ok(!cleaned.includes(FAKE_KEY));
  assert.equal(cleaned, "Bearer [REDACTED] failed, retry with [REDACTED]");
});
