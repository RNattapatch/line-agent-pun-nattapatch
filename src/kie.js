/*
 * ตัวต่อ kie.ai — ใช้เฉพาะตอน pre-generate รูป (scripts/gen-images.mjs)
 * ตัวบอทตอนรันจริง "ไม่" เรียกไฟล์นี้ เพราะการ gen ใช้เวลาราว 50 วินาที
 * แต่ LINE รอ webhook แค่ ~10 วินาที (ดูเหตุผลเต็มใน README)
 *
 * ยืนยันกับ API จริงแล้วเมื่อ 2026-08-14 (ไม่ได้เดาจากเอกสารเก่า):
 *   POST /api/v1/jobs/createTask   -> { code, data: { taskId } }
 *   GET  /api/v1/jobs/recordInfo?taskId=...
 *        -> data.state ∈ waiting | queuing | generating | success | fail
 *           data.resultJson (string JSON) -> { resultUrls: ["https://..."] }
 *           data.creditsConsumed          -> 4 เครดิต/รูป สำหรับ google/nano-banana
 *   URL ที่ได้อยู่บนโดเมน tempfile.* และเอกสารระบุว่าหมดอายุราว 24 ชม.
 *   -> ต้องโหลดมาโฮสต์เอง ไม่งั้นลูกค้าจะเห็นรูปพัง
 *
 * ความลับ: อ่าน key จาก process.env.KIE_API_KEY เท่านั้น
 *          ทุก error ที่โยนออกจากไฟล์นี้ผ่าน redact() ก่อนเสมอ
 */

import fs from "node:fs";

const BASE = "https://api.kie.ai/api/v1";
export const MODEL = "google/nano-banana";
export const CREDITS_PER_IMAGE = 4;

const apiKey = () => {
  const key = process.env.KIE_API_KEY;
  if (!key) throw new Error("ไม่พบ KIE_API_KEY — เติมใน .env ก่อน (ดู .env.example)");
  return key;
};

/*
 * กัน key หลุดออกไปกับข้อความ error / log
 * repo นี้เป็น public ถ้า key ติดไปกับ stack trace ที่ใครสักคนแปะใน issue คือหลุดจริง
 */
export function redact(text) {
  const key = process.env.KIE_API_KEY;
  const s = String(text);
  return key ? s.split(key).join("[REDACTED]") : s;
}

const fail = (msg) => {
  throw new Error(redact(msg));
};

const headers = () => ({
  Authorization: `Bearer ${apiKey()}`,
  "Content-Type": "application/json",
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    // บาง error (502 จาก edge, หน้า HTML) ไม่ได้กลับมาเป็น JSON
    fail(`kie.ai ตอบไม่ใช่ JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
}

export async function createTask(prompt, { aspectRatio = "1:1", outputFormat = "jpeg" } = {}) {
  const res = await fetch(`${BASE}/jobs/createTask`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      model: MODEL,
      input: { prompt, aspect_ratio: aspectRatio, output_format: outputFormat },
    }),
  });

  const json = await readJson(res);
  const taskId = json?.data?.taskId;
  if (!res.ok || !taskId) {
    /*
     * kie.ai ตอบ HTTP 200 แม้ตอนที่ผิดพลาด แล้วใส่โค้ดจริงไว้ในช่อง code ของ body
     * เลยต้องอ่านจาก body ก่อน ไม่งั้น log จะขึ้น "HTTP 200" ทั้งที่ key ผิด
     * 401 = key ผิด · 402 = เครดิตหมด · 429 = ยิงถี่เกิน (เพดาน 20 req/10 วินาที)
     */
    fail(`createTask ไม่สำเร็จ (code ${json?.code ?? res.status}): ${json?.msg ?? JSON.stringify(json).slice(0, 200)}`);
  }
  return taskId;
}

export async function pollTask(taskId, { intervalMs = 5000, timeoutMs = 300000, onState } = {}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const res = await fetch(`${BASE}/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, {
      headers: headers(),
    });
    const json = await readJson(res);
    const data = json?.data ?? {};

    onState?.(data.state, data.progress);

    if (data.state === "success") {
      const urls = JSON.parse(data.resultJson || "{}").resultUrls ?? [];
      if (!urls.length) fail(`task ${taskId} สำเร็จแต่ไม่มี URL กลับมา`);
      return { url: urls[0], credits: data.creditsConsumed ?? CREDITS_PER_IMAGE };
    }
    if (data.state === "fail") {
      fail(`task ${taskId} ล้มเหลว: ${data.failMsg || data.failCode || "ไม่ทราบสาเหตุ"}`);
    }

    await sleep(intervalMs);
  }

  fail(`task ${taskId} ไม่เสร็จภายใน ${Math.round(timeoutMs / 1000)} วินาที`);
}

/* โหลดไฟล์จาก URL ชั่วคราวของ kie.ai มาเก็บไว้เอง — ต้องทำ ไม่งั้นรูปพังใน 24 ชม. */
export async function downloadTo(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) fail(`ดาวน์โหลดรูปไม่สำเร็จ (HTTP ${res.status})`);

  const contentType = res.headers.get("content-type") ?? "";
  // LINE รับเฉพาะ JPEG กับ PNG — ถ้าไม่ใช่ ให้ตายตรงนี้ ดีกว่าปล่อยรูปพังไปถึงลูกค้า
  if (!/image\/(jpeg|png)/.test(contentType)) {
    fail(`ไฟล์ที่ได้ไม่ใช่ JPEG/PNG (content-type: ${contentType})`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buf);
  return { bytes: buf.length, contentType };
}

export async function generateImage(prompt, opts = {}) {
  const taskId = await createTask(prompt, opts);
  const { url, credits } = await pollTask(taskId, opts);
  return { taskId, url, credits };
}

export async function getCredits() {
  const res = await fetch(`${BASE}/chat/credit`, { headers: headers() });
  const json = await readJson(res);
  // เช็คโค้ดใน body ด้วย ไม่งั้น key ผิดจะได้ค่า null เงียบ ๆ แทนที่จะรู้ว่า auth ไม่ผ่าน
  if (json?.code !== 200) fail(`เช็คเครดิตไม่สำเร็จ (code ${json?.code ?? res.status}): ${json?.msg ?? ""}`);
  return json.data;
}
