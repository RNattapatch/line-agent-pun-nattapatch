/*
 * ออก QR รับเงิน — ด่านอนุญาต + สร้างไฟล์ภาพบนเครื่องเราเอง
 *
 * ═══ ลำดับด่านที่ห้ามสลับ ═══
 *   1. หาใบจาก quote_id ที่ติดมากับ postback (ไม่ใช่จากตัวเลขหรือข้อความที่ลูกค้าพิมพ์)
 *   2. ใบนี้เป็นของ LINE user คนที่กดจริงไหม — เช็คทั้ง field ในใบ และ index ของ user คนนั้น
 *   3. หมดอายุหรือยัง (เช็คซ้ำ ถึงแม้ store.get จะเลื่อนสถานะให้แล้ว)
 *   4. สถานะออก QR ได้ไหม — เฉพาะ "ตรวจแล้ว" กับ "ส่งลูกค้า"
 *   5. ยอดมาจาก record เท่านั้น — postback ส่งมาได้แค่ "มัดจำ" หรือ "เต็มจำนวน"
 *
 * ข้อ 2 สำคัญที่สุด: quote_id เดาได้ (Q-วันที่-เลขรัน) ถ้าไม่เช็คเจ้าของใบ
 * ใครก็ได้จะยิง postback เดาเลขใบของคนอื่น แล้วเห็นยอดของคนอื่นทันที
 *
 * ═══ ไฟล์ภาพ ═══
 * เกิดบน VPS ทั้งหมด (ดู src/qr-encode.js) เก็บนอก repo เหมือนใบเสนอราคา
 * ชื่อไฟล์เป็นสตริงสุ่ม ไม่ได้ตั้งตาม quote_id — URL ของภาพต้องให้ LINE โหลดได้
 * แปลว่าใครถือ URL ก็เปิดได้ ถ้าตั้งชื่อตามเลขใบ คนที่เดาเลขใบเป็นก็เดา URL ได้ด้วย
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { auditRef } from "./payment.js";
import { promptPayPayload } from "./promptpay.js";
import { encodeQr } from "./qr-encode.js";
import { modulesToPng } from "./qr-png.js";
import { STATUS, canIssueQr } from "./quotes.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/* ยอดที่ออก QR ได้ — ชื่อชนิดเท่านั้น ตัวเลขไปหยิบจาก record เอง */
export const AMOUNT_KINDS = {
  deposit: { key: "deposit", label: "มัดจำ" },
  full: { key: "net", label: "เต็มจำนวน" },
};

export const qrDir = () =>
  process.env.SHOP_DATA_DIR
    ? path.join(process.env.SHOP_DATA_DIR, "qr")
    : path.join(os.homedir(), "shop-data", "qr");

/* ภาพ QR เก็บไว้กี่ชั่วโมงก่อนกวาดทิ้ง — ผูกกับยอดของใบเดียว ไม่ได้มีไว้ใช้ซ้ำ */
const TTL_HOURS = 24;

/*
 * กวาดภาพเก่าทิ้งทุกครั้งที่ออกใบใหม่ — ไม่ตั้ง cron แยก
 * โฟลเดอร์นี้มีไฟล์หลักสิบ การอ่านทั้งโฟลเดอร์จึงถูกกว่าการมี cron อีกตัวให้ลืมดูแล
 */
function sweep(dir, now) {
  const cutoff = now.getTime() - TTL_HOURS * 60 * 60 * 1000;
  let removed = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".png")) continue;
    const file = path.join(dir, name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) {
        fs.unlinkSync(file);
        removed++;
      }
    } catch {
      /* ไฟล์หายไประหว่างกวาด — ปลายทางที่ต้องการอยู่แล้ว ไม่ต้องทำอะไรต่อ */
    }
  }
  return removed;
}

/*
 * ใบนี้เป็นของ LINE user คนนี้จริงไหม
 * เช็คสองทางให้ตรงกันทั้งคู่: field ในตัวใบ และ index ของ user คนนั้น
 * ใบที่ไม่มี line_user_id (ออกจากห้องกลุ่ม) ถือว่าเช็คไม่ผ่าน — ไม่ออก QR ให้ ปลอดภัยกว่าเดา
 */
export function belongsTo(quote, lineUserId, store) {
  if (!quote || !lineUserId || !quote.line_user_id) return false;
  if (quote.line_user_id !== lineUserId) return false;
  return store.byUser(lineUserId).some((q) => q.quote_id === quote.quote_id);
}

/*
 * ออก QR — คืน { ok, reason, quote, amount, ... } เสมอ ไม่โยน error ให้ผู้เรียกต้องดัก
 * reason เป็นรหัสสั้น ๆ ให้ผู้เรียกแปลเป็นข้อความลูกค้าเอง (คนละคำกับที่แจ้งแอดมิน)
 */
export function issueQr({
  store,
  quoteId,
  lineUserId,
  destination,
  amountKind = "deposit",
  dir = qrDir(),
  now = () => new Date(),
} = {}) {
  const at = now();
  const quote = store.get(quoteId);

  if (!quote) return { ok: false, reason: "not-found", quote: null };
  if (!belongsTo(quote, lineUserId, store)) return { ok: false, reason: "not-yours", quote: null };

  /* เช็คหมดอายุเอง ไม่พึ่งสถานะอย่างเดียว — ใบที่เพิ่งเลยเวลาเมื่อวินาทีก่อนต้องไม่รอด */
  if (quote.status === STATUS.EXPIRED || new Date(quote.expires_at).getTime() <= at.getTime()) {
    return { ok: false, reason: "expired", quote };
  }
  if (!canIssueQr(quote)) return { ok: false, reason: "status", quote };

  if (!destination || destination.type !== "promptpay") {
    return { ok: false, reason: "no-destination", quote };
  }

  const kind = AMOUNT_KINDS[amountKind];
  if (!kind) return { ok: false, reason: "bad-amount-kind", quote };

  /* ยอดมาจาก record เท่านั้น — ไม่มีทางให้ตัวเลขจากแชทเข้ามาถึงบรรทัดนี้ */
  const amount = quote[kind.key];
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: "bad-amount", quote };

  const payload = promptPayPayload({ phone: destination.number, amount });
  if (!payload) return { ok: false, reason: "bad-destination", quote };

  let file;
  let token;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    fs.chmodSync(dir, DIR_MODE);
    sweep(dir, at);

    token = crypto.randomBytes(16).toString("hex");
    file = path.join(dir, `${token}.png`);
    fs.writeFileSync(file, modulesToPng(encodeQr(payload).modules), { mode: FILE_MODE });
    fs.chmodSync(file, FILE_MODE);
  } catch (err) {
    /* ห้าม log ตัว payload — ข้างในมีเลขพร้อมเพย์ของร้าน */
    console.error("สร้างไฟล์ QR ไม่สำเร็จ:", err.message);
    return { ok: false, reason: "render-failed", quote };
  }

  /*
   * ส่ง QR ออกไปแล้ว = ใบนี้ถึงมือลูกค้าแล้ว เลื่อนเป็น "ส่งลูกค้า"
   * ใบที่เป็น "ส่งลูกค้า" อยู่แล้ว (ขอ QR ซ้ำ / ขอคนละบัญชี) ปล่อยสถานะไว้เหมือนเดิม
   */
  if (quote.status === STATUS.REVIEWED) {
    store.advance(quote.quote_id, STATUS.SENT, { actor: "bot", note: "ส่ง QR ชำระเงินให้ลูกค้า" });
  }

  /*
   * ร่องรอยต้องพอให้ตอบได้ว่า "ใบไหน ยอดเท่าไหร่ ช่องทางไหน เมื่อไหร่"
   * แต่ต้องไม่มีเลขบัญชี ไม่มี payload และไม่มีชื่อไฟล์ภาพ (ชื่อไฟล์คือ URL ที่เปิดภาพได้)
   */
  const current = store.get(quote.quote_id);
  current.audit.push({
    at: at.toISOString(),
    actor: "bot",
    action: "qr-issued",
    amount,
    amount_kind: amountKind,
    ...auditRef(destination),
  });
  store.save(current);

  return { ok: true, quote: current, amount, amountLabel: kind.label, token, file, destination };
}
