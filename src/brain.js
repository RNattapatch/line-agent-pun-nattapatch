/*
 * สมองร้าน — ใช้ตอบคำถามปลายเปิดที่กฎตายตัวใน reply.js ตอบไม่ได้
 *
 * ทำไมต้องมี: reply.js รู้จักแค่คำทักทาย คำว่า "เมนู" และคำขอดูรูป
 * ลูกค้าถามว่า "ร้านอะไร มีโปรอะไรบ้าง ส่งยังไง" จะตกไปหาแอดมินหมด
 * ซึ่งเสียโอกาสขายและกวนแอดมินทั้งวัน
 *
 * ขอบเขตที่จงใจกันไว้:
 *   - เรื่องรูปไม่ผ่านตรงนี้เลย — reply.js ตัดสินเองก่อนแล้ว
 *     สมองจึงไม่มีทางไปสัญญากับลูกค้าว่าจะส่งรูป แล้วส่งไม่ได้
 *   - ทุกคำตอบผ่าน sanitize() ก่อนถึงลูกค้า ถ้าไม่ผ่านให้ทิ้งแล้วใช้ข้อความสำรอง
 *     ต่อให้โมเดลหลุดพูดว่าตัวเองเป็น AI หรือพ่น URL ออกมา ลูกค้าก็ไม่เห็น
 *   - เรื่องที่ผิดแล้วเสียเงินจริง (ร้องเรียน คืนเงิน ของเสีย) บังคับส่งต่อคนเสมอ
 *     ไม่ปล่อยให้โมเดลตัดสินเอง แม้จะตอบได้ดูดีแค่ไหน
 *   - คุยทีละข้อความ ไม่เก็บประวัติ — เหมือนที่ตั้งไว้เดิมตอนใช้ Hermes
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/* ไฟล์สมองร้าน — ชุดเดียวกับที่ Hermes เคยใช้ แก้ที่ repo แล้ว deploy ตามปกติ */
export const BRAIN_FILES = ["context.md", "products.md", "promotions.md"];

export const DEFAULT_MODEL = "openai/gpt-5.6-luna";
export const DEFAULT_TIMEOUT_MS = 12_000;

const API_URL = "https://openrouter.ai/api/v1/chat/completions";

/* เพดานความยาว — LINE รับ 5000 ตัวต่อบับเบิล แต่ตอบยาวขนาดนั้นผิดกติกาน้ำเสียงอยู่แล้ว */
const MAX_REPLY_CHARS = 700;

/*
 * เรื่องที่ห้ามให้โมเดลตัดสินเอง — ตอบผิดแล้วเป็นเงินจริงหรือเป็นเรื่องร้องเรียน
 * (context.md ข้อ 5) เจอเมื่อไหร่ส่งต่อคนทันที ไม่ต้องถามสมอง
 */
const NEEDS_HUMAN = /(ร้องเรียน|คืนเงิน|รีฟันด์|refund|เคลม|ของเสีย|ของพัง|บูด|เน่า|ราขึ้น|ฟ้อง|ไม่พอใจ|แย่มาก)/i;

/*
 * คำที่ห้ามหลุดถึงลูกค้าเด็ดขาด (context.md ข้อ 6)
 * ชุดเดียวกับที่ tests/reply.test.js กวาดไว้ บวก path/URL ที่เคยหลุดมาแล้วจริง
 */
const FORBIDDEN = [
  /\bAI\b/i,
  /บอท/,
  /โมเดล/,
  /แชทบอท/i,
  /chatbot/i,
  /language model/i,
  /สร้างรูป(ภาพ)?ไม่ได้/,
  /generate|kie\.ai|openrouter|api|error|cache|แคช|url|http/i,
  /\/images\//,
  /\.(jpe?g|png)\b/i,
  /system prompt|prompt|context\.md|products\.md|promotions\.md/i,
];

let cachedPrompt = null;

/* อ่านไฟล์สมองครั้งเดียวตอนบูต — เปลี่ยนไฟล์แล้วต้องรีสตาร์ต เหมือนแคชรูป */
export function loadBrain({ root = ROOT, files = BRAIN_FILES } = {}) {
  const parts = [];
  for (const name of files) {
    try {
      parts.push(fs.readFileSync(path.join(root, name), "utf8").trim());
    } catch {
      // ไฟล์ไหนหายก็ข้าม ดีกว่าทำให้ทั้งบอทดับ — ที่เหลือยังตอบได้
    }
  }
  return parts.join("\n\n---\n\n");
}

export function systemPrompt(brain = loadBrain()) {
  return [
    brain,
    "",
    "---",
    "",
    "กติกาการตอบข้อความนี้:",
    "- ตอบเป็นภาษาไทย สั้น กระชับ ตรงคำถาม ไม่เกิน 3 ประโยค",
    "- ลงท้ายด้วย คะ หรือ ค่ะ เสมอ",
    "- ตอบในนามแอดมินร้านเท่านั้น ห้ามบอกว่าตัวเองเป็น AI ผู้ช่วย หรือระบบอัตโนมัติ",
    "- ใช้เฉพาะข้อมูลข้างบน ห้ามแต่งราคา โปรโมชั่น หรือเงื่อนไขขึ้นเอง",
    "- ข้อมูลที่ไม่มีเขียนไว้ ให้บอกว่าขอเช็กให้ก่อนนะคะ",
    "- ห้ามพิมพ์ลิงก์ ที่อยู่ไฟล์ หรือศัพท์เทคนิคใด ๆ",
    "- เรื่องรูปภาพมีระบบอื่นดูแลอยู่แล้ว ไม่ต้องรับปากว่าจะส่งรูปให้",
  ].join("\n");
}

/* เรื่องนี้ต้องให้คนตอบ ไม่ต้องเสียเวลาถามสมอง */
export const needsHuman = (text) => NEEDS_HUMAN.test(String(text ?? ""));

/*
 * ตรวจคำตอบก่อนถึงลูกค้า — คืนข้อความที่ใช้ได้ หรือ null ถ้าใช้ไม่ได้
 * null = ผู้เรียกต้องไปใช้ข้อความสำรอง + ส่งต่อแอดมิน
 */
export function sanitize(reply) {
  let text = String(reply ?? "").trim();
  if (!text) return null;

  // markdown ที่ LINE แสดงไม่ได้ ตัดทิ้งให้เหลือข้อความเปล่า
  text = text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[\s]*[-*+]\s+/gm, "• ")
    .trim();

  if (text.length > MAX_REPLY_CHARS) return null;
  if (FORBIDDEN.some((re) => re.test(text))) return null;
  // กติกาน้ำเสียง (context.md ข้อ 2) — ลงท้ายไม่ถูกแปลว่าโมเดลหลุดคาแรกเตอร์
  if (!/(คะ|ค่ะ)[\s.!?]*$/.test(text)) return null;

  return text;
}

/* ตัด API key ออกจากข้อความ error กัน key ติดไปกับ log */
export const redact = (msg) => String(msg ?? "").replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***");

/*
 * ถามสมองร้าน — คืนข้อความที่ผ่าน sanitize แล้ว หรือ null
 * null ทุกกรณีที่ไม่ชัวร์: ไม่มี key / เน็ตล่ม / ช้าเกินกำหนด / คำตอบไม่ผ่านด่าน
 * ผู้เรียกไปใช้ข้อความสำรอง + ส่งต่อแอดมิน ลูกค้าไม่มีทางเห็น error
 */
export async function askBrain(userText, options = {}) {
  const {
    apiKey = process.env.OPENROUTER_API_KEY,
    model = process.env.OPENROUTER_MODEL || DEFAULT_MODEL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    prompt = (cachedPrompt ??= systemPrompt()),
    fetchImpl = fetch,
  } = options;

  if (!apiKey || !String(userText ?? "").trim()) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 400,
        temperature: 0.3,
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: String(userText) },
        ],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      console.warn(`สมองร้านตอบไม่สำเร็จ: HTTP ${res.status}`);
      return null;
    }

    const data = await res.json();
    return sanitize(data?.choices?.[0]?.message?.content);
  } catch (err) {
    console.warn(`สมองร้านตอบไม่สำเร็จ: ${redact(err?.message)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
