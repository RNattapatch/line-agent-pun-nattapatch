/*
 * ด่านของ Build Lab — กันไม่ให้ห้องทดลองไปโผล่ในที่ที่ไม่ควรอยู่
 *
 * ═══ ทำไม Lab ต้องแยกขาดจากตัวที่รับลูกค้าจริง ═══
 * Lab มีหน้าที่ "เดา" — เดาว่าลูกค้ากลุ่มไหนกำลังโต เดาว่าควรแก้ FAQ ตรงไหน
 * ของที่เดาได้ ย่อมเดาผิดได้ และถ้ามันอยู่ในเส้นทางเดียวกับที่ตอบลูกค้าจริง
 * วันหนึ่งข้อสรุปที่เดาผิดจะไหลออกไปถึงลูกค้าโดยไม่มีใครกดอนุมัติ
 *
 * ชั้นกันที่ใช้:
 *   1. ต้องตั้ง LAB_ENV=staging — ไม่ตั้ง = รันไม่ได้เลย
 *   2. เจอร่องรอยของ production (มี LINE token / มีแอดมิน claim อยู่) = ปฏิเสธ
 *   3. src/server.js ห้าม import อะไรจาก src/lab/ (มีเทสต์กวาดไว้)
 *   4. ผลลัพธ์เขียนนอก repo เสมอ
 *
 * ═══ Privacy Gate ═══
 * ข้อมูลที่เข้า Lab ต้องเป็น pseudonymous ล้วน ตรวจด้วย "allowlist ของคีย์"
 * ไม่ใช่ "blocklist ของคำต้องห้าม" — เพราะ blocklist จะพลาดเสมอกับสิ่งที่ยังไม่เคยเห็น
 * ส่วนชื่อคนกับเบอร์โทรที่โจทย์สั่งให้ลบ ถูกกวาดซ้ำอีกชั้นด้วย pattern
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/* ผลลัพธ์ของ Lab อยู่นอก repo เสมอ — repo นี้เป็น public */
export const labDir = () =>
  process.env.LAB_OUT_DIR ? process.env.LAB_OUT_DIR : path.join(os.homedir(), "shop-lab");

/* เก็บผลไว้กี่วัน */
export const RETENTION_DAYS = 15;

/*
 * คีย์ที่อนุญาตให้มีใน 1 event ที่เข้า Lab
 * อะไรที่ไม่อยู่ในนี้ = ปฏิเสธทั้งชุด ไม่ใช่ตัดคีย์นั้นทิ้งแล้วไปต่อ
 * (ตัดทิ้งเงียบ ๆ แปลว่าวันหนึ่งจะมีฟิลด์ใหม่โผล่มาแล้วไม่มีใครรู้ว่ามันเคยมี)
 */
export const ALLOWED_EVENT_KEYS = new Set([
  "id", "at", "suffix", "intent", "lead", "handoff", "unanswered", "next_step", "triggers", "product",
]);

/*
 * รูปแบบที่ถือว่าเป็นข้อมูลส่วนบุคคล — กวาดทุกค่าที่เป็นสตริง
 * โจทย์สั่งเฉพาะ "ชื่อและเบอร์โทร" แต่กวาดกว้างกว่านั้นไว้ก่อน
 * ของที่หลุดไปแล้วเอาคืนไม่ได้ ส่วนการกวาดเกินแค่ทำให้ต้องมาแก้ข้อมูลทดลอง
 */
export const PII_PATTERNS = [
  /*
   * เบอร์โทรไทย — ต้องได้ 9-10 หลักจริง ๆ และต้องไม่ติดกับตัวเลข/ขีดอื่น
   *
   * เคยเขียนหลวมกว่านี้แล้ว "2026-09-16" ถูกจับเป็นเบอร์โทร (อ่าน "026-09-16" เป็นเบอร์)
   * ซึ่งทำให้รายงานทุกฉบับถูกบล็อกตั้งแต่ใบแรก เพราะทุกใบมีวันที่อยู่
   * ด่านที่บล็อกทุกอย่างมีค่าเท่ากับด่านที่ไม่บล็อกอะไรเลย — คนจะปิดมันทิ้ง
   */
  { name: "เบอร์โทร", re: /(?<![\d-])(?:\+?66[\s-]?|0)\d(?:[\s-]?\d){7,8}(?![\d-])/ },
  { name: "LINE user id เต็ม", re: /\bU[0-9a-f]{32}\b/ },
  { name: "อีเมล", re: /[\w.+-]+@[\w-]+\.[\w.]+/ },
  { name: "เลขบัตรประชาชน", re: /\b\d{13}\b/ },
  { name: "เลขบัญชีธนาคาร", re: /\b\d{3}-\d-\d{4,5}-\d\b/ },
  { name: "ชื่อคนพร้อมคำนำหน้า", re: /(?:คุณ|นาย|นางสาว|นาง|น\.ส\.)\s*[ก-๙]{2,}/ },
  /*
   * ที่อยู่ — ต้องมี "ตัวเลข" หรือคำแบ่งเขตปกครองจริง ๆ
   *
   * เคยเขียนหลวมกว่านี้ (จับคำว่า จังหวัด/ถนน เปล่า ๆ) แล้วมันไปจับคำถามธรรมดา
   * อย่าง "ส่งต่างจังหวัดได้ไหม" ว่าเป็นที่อยู่ลูกค้า
   *
   * ด่านที่ดังเกินจริงอันตรายกว่าที่คิด — พอมันเตือนผิดบ่อย ๆ คนจะเริ่มกดผ่านโดยไม่อ่าน
   * แล้ววันที่มันเตือนถูกก็จะถูกกดผ่านไปด้วย
   */
  { name: "ที่อยู่", re: /(?:บ้านเลขที่|เลขที่)\s*\d|\d+\/\d+\s*(?:หมู่|ซอย|ถ\.|ถนน)|(?:แขวง|เขต|ตำบล|อำเภอ)\s*[ก-๙]{2,}/ },
];

/* ความยาวที่ถือว่าเป็น "บทสนทนาดิบ" ไม่ใช่ข้อมูลสรุป */
const RAW_CHAT_CHARS = 200;

export class LabRefused extends Error {}

/*
 * ตรวจว่ารันอยู่ใน staging จริง — โยน LabRefused ถ้าไม่ใช่
 * env รับเข้ามาเพื่อให้เทสต์จำลองสภาพแวดล้อมได้โดยไม่ต้องแตะ process.env จริง
 */
export function assertStaging({ env = process.env, claims = null } = {}) {
  if (String(env.LAB_ENV ?? "").trim() !== "staging") {
    throw new LabRefused("Build Lab รันได้เฉพาะ staging — ต้องตั้ง LAB_ENV=staging");
  }

  /*
   * เครื่องที่มี LINE token อยู่ = เครื่องที่รับลูกค้าจริงได้
   * ต่อให้ใครตั้ง LAB_ENV=staging บนเครื่องนั้น ก็ยังไม่ใช่ staging อยู่ดี
   */
  if (env.CHANNEL_ACCESS_TOKEN || env.CHANNEL_SECRET) {
    throw new LabRefused("เครื่องนี้มี LINE token อยู่ — เป็นเครื่องที่รับลูกค้าจริงได้ Lab จึงรันไม่ได้");
  }

  if (claims?.currentAdmin?.()) {
    throw new LabRefused("มีแอดมิน claim สิทธิ์อยู่ (โหมดใช้งานจริง) — Lab รันไม่ได้");
  }

  return true;
}

/*
 * Privacy Gate — ข้อมูลชุดนี้เข้า Lab ได้ไหม
 * คืน { ok, findings } · findings ต้องว่างเปล่าเท่านั้นถึงจะผ่าน
 */
export function privacyGate(records) {
  const findings = [];
  const list = Array.isArray(records) ? records : [records];

  list.forEach((record, i) => {
    const where = `event[${i}]`;

    if (!record || typeof record !== "object") {
      findings.push({ where, why: "ไม่ใช่ record ที่อ่านได้" });
      return;
    }

    for (const key of Object.keys(record)) {
      if (!ALLOWED_EVENT_KEYS.has(key)) {
        findings.push({ where, why: `มีคีย์ที่ไม่อนุญาต: "${key}"` });
      }
    }

    /* suffix ต้องเป็น 4 ตัวเท่านั้น ยาวกว่านั้นแปลว่ามี id เต็มหลุดมา */
    if (record.suffix !== undefined && !/^[\w?]{1,4}$/.test(String(record.suffix))) {
      findings.push({ where, why: "suffix ต้องยาวไม่เกิน 4 ตัว" });
    }

    for (const [key, value] of Object.entries(record)) {
      for (const text of flattenStrings(value)) {
        if (text.length > RAW_CHAT_CHARS) {
          findings.push({ where, why: `"${key}" ยาวเกิน ${RAW_CHAT_CHARS} ตัว — น่าจะเป็นบทสนทนาดิบ` });
        }
        for (const p of PII_PATTERNS) {
          if (p.re.test(text)) findings.push({ where, why: `"${key}" มี${p.name}` });
        }
      }
    }
  });

  return { ok: findings.length === 0, findings };
}

const flattenStrings = (value) => {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(flattenStrings);
  if (value && typeof value === "object") return Object.values(value).flatMap(flattenStrings);
  return [];
};

/*
 * กวาดข้อความที่กำลังจะส่งให้เจ้าของร้านดู — ต้องได้ศูนย์ก่อนเสมอ
 * ต่างจาก privacyGate ตรงที่ตัวนั้นตรวจ "ข้อมูลเข้า" ส่วนตัวนี้ตรวจ "ของที่จะออกไป"
 * ต้องมีทั้งสองด้าน เพราะ Lab ประกอบข้อความขึ้นมาเองระหว่างทาง
 */
export function scanOutput(text) {
  const body = String(text ?? "");
  const findings = [];
  for (const p of PII_PATTERNS) {
    const hit = body.match(p.re);
    if (hit) findings.push({ why: `พบ${p.name}`, sample: hit[0].slice(0, 4) + "…" });
  }
  return { ok: findings.length === 0, findings };
}

/* ปิดบังชื่อ/เบอร์ที่หลุดเข้ามา — ใช้กับข้อมูลทดลองที่ import มาจากที่อื่น */
export function redact(text) {
  let out = String(text ?? "");
  for (const p of PII_PATTERNS) out = out.replace(new RegExp(p.re, "g"), "[ปิดบัง]");
  return out;
}

/* ลบผลลัพธ์เก่าเกิน retention */
export function sweepLab({ dir = labDir(), days = RETENTION_DAYS, now = () => new Date() } = {}) {
  const cutoff = now().getTime() - days * 24 * 60 * 60 * 1000;
  let removed = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    try {
      if (fs.statSync(full).mtimeMs >= cutoff) continue;
      fs.rmSync(full, { recursive: true, force: true });
      removed++;
    } catch {
      /* หายไปแล้ว */
    }
  }
  return removed;
}
