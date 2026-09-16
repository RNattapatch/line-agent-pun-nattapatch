/*
 * Quote Engine — ออกใบเสนอราคาจริง เก็บลงดิสก์บน VPS เท่านั้น
 *
 * ═══ กติกาที่ห้ามละเมิด ═══
 *  1. ราคาทุกบาทมาจากตารางใน products.md (src/price-source.js) เสมอ
 *     ห้ามแต่งราคา ห้ามรับ "ยอดลอย" ที่ลูกค้าพิมพ์มาเอง — ผู้เรียกส่งมาได้แค่ slug กับจำนวน
 *  2. ธุรกรรมจริงอยู่ที่ ~/shop-data/quotes/ เท่านั้น โฟลเดอร์ 700 ไฟล์ 600
 *     ห้ามเข้า repo (repo นี้เป็น public) — cards/ เก็บได้แค่ template กับคีย์เวิร์ด
 *  3. ส่วนลดเกินเพดาน หรือยอดเกินเกณฑ์ → คง draft เสมอ ให้เจ้าของร้านตัดสิน
 *     บอทไม่มีสิทธิ์เลื่อนสถานะข้ามข้อนี้เอง
 *  4. ใบที่ส่งลูกค้าไปแล้วห้ามแก้ทับ ต้องขึ้น version ใหม่ + บันทึก audit (ดู reviseQuote)
 *
 * ═══ ทำไมคิดเงินเป็นสตางค์ ═══
 * 189 * 3 * 0.95 ด้วย float ได้ 538.6500000000001 ซึ่งพอ toFixed แล้วอาจปัดคนละทางกับที่
 * เจ้าของร้านคิดในกระดาษ ใบเสนอราคาเป็นเอกสารที่ลูกค้าเอาไปเทียบยอดโอน คลาดกัน 1 สตางค์ก็เป็นเรื่อง
 * ข้างในจึงเป็นจำนวนเต็มสตางค์ล้วน แล้วค่อยหารร้อยตอนเก็บลงไฟล์
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { priceList, priceOf } from "./price-source.js";

/* ───────── นโยบายร้าน — ตัวเลขชุดเดียวที่ทั้งระบบอ้างอิง ───────── */

/*
 * อ่านตัวเลขจาก .env แบบไม่ยอมให้ค่าพังหลุดเข้ามา
 *
 * Number("") เป็น 0 และ Number("# คอมเมนต์") เป็น NaN ซึ่งทั้งคู่รอดจาก ?? ไปได้
 * ถ้าปล่อยไว้ เพดานส่วนลดจะกลายเป็น 0 (ลดไม่ได้เลยสักบาท) หรือ NaN
 * ซึ่งทำให้ "ส่วนลด > NaN" เป็น false ตลอด = เพดานหายไปเงียบ ๆ ทั้งที่ตั้งใจจะคุม
 * เรื่องเงินแบบนี้ต้องพังแบบเห็น ๆ หรือไม่ก็ตกไปใช้ค่าเริ่มต้น ห้ามพังเงียบ
 */
const policy = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    console.warn(`⚠️  ${name}="${raw}" ไม่ใช่ตัวเลขที่ใช้ได้ — ใช้ค่าเริ่มต้น ${fallback} แทน`);
    return fallback;
  }
  return value;
};

/* ส่วนลดที่บอทตัดสินใจเองได้ เกินนี้ต้องรอเจ้าของร้าน */
export const DISCOUNT_CAP_PERCENT = policy("QUOTE_DISCOUNT_CAP", 5);

/* ยอดสุทธิที่เกินแล้วต้องรอเจ้าของร้าน */
export const HIGH_VALUE_BAHT = policy("QUOTE_HIGH_VALUE", 50_000);

/* มัดจำ */
export const DEPOSIT_PERCENT = policy("QUOTE_DEPOSIT_PERCENT", 50);

/* อายุใบเสนอราคา */
export const VALID_DAYS = policy("QUOTE_VALID_DAYS", 3);

/* ───────── สถานะ ───────── */

export const STATUS = {
  DRAFT: "draft",
  REVIEWED: "ตรวจแล้ว",
  SENT: "ส่งลูกค้า",
  SLIP: "รับสลิปแล้ว",
  PAID: "ยืนยันชำระแล้ว",
  EXPIRED: "หมดอายุ",
  CANCELLED: "ยกเลิก",
};

/* เส้นทางที่อนุญาต — ข้ามขั้นไม่ได้ ถอยหลังไม่ได้ */
const FLOW = {
  [STATUS.DRAFT]: [STATUS.REVIEWED, STATUS.CANCELLED, STATUS.EXPIRED],
  [STATUS.REVIEWED]: [STATUS.SENT, STATUS.CANCELLED, STATUS.EXPIRED],
  [STATUS.SENT]: [STATUS.SLIP, STATUS.CANCELLED, STATUS.EXPIRED],
  [STATUS.SLIP]: [STATUS.PAID, STATUS.CANCELLED],
  [STATUS.PAID]: [],
  [STATUS.EXPIRED]: [],
  [STATUS.CANCELLED]: [],
};

/* สถานะที่จบแล้ว — หมดเวลาแล้วก็ไม่ต้องไปเปลี่ยนเป็น "หมดอายุ" ซ้ำ */
const TERMINAL = new Set([STATUS.PAID, STATUS.CANCELLED, STATUS.EXPIRED]);

/* สถานะที่ถือว่า "กำลังรอเงินลูกค้าอยู่" — ตัวส่งการ์ดต้องเงียบ */
export const PAYMENT_STATUSES = new Set([STATUS.SENT, STATUS.SLIP]);

/* ───────── ที่เก็บ ───────── */

export const defaultDir = () =>
  process.env.SHOP_DATA_DIR
    ? path.join(process.env.SHOP_DATA_DIR, "quotes")
    : path.join(os.homedir(), "shop-data", "quotes");

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

const pad3 = (n) => String(n).padStart(3, "0");
const yyyymmdd = (d) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;

/* suffix 4 ตัวท้ายของห้องแชท — ตัวเดียวที่โผล่ในรายงาน/แจ้งเตือนแอดมิน */
export const suffixOf = (id) => String(id ?? "").slice(-4) || "????";

/* ชื่อไฟล์ index ของลูกค้า 1 คน — hash เพื่อให้ปลอดภัยกับ filesystem ไม่ใช่เพื่อปกปิด
 * (ตัวไฟล์ข้างในเก็บ LINE user id เต็ม เพราะต้องย้อนกลับไปหาลูกค้าให้ได้จริง) */
const userKey = (lineUserId) =>
  crypto.createHash("sha256").update(String(lineUserId)).digest("hex").slice(0, 32);

export function createQuoteStore({ dir = defaultDir(), now = () => new Date(), source = priceList } = {}) {
  const indexDir = path.join(dir, "index");

  /*
   * โฟลเดอร์ 700 ไฟล์ 600 — chmod ซ้ำหลัง mkdir เสมอ
   * เพราะ mode ของ mkdir โดน umask ของ process หักออกอีกที (umask 022 → ได้ 755 ไม่ใช่ 700)
   * ใบเสนอราคามีชื่อลูกค้า ยอดเงิน และ LINE user id เต็ม ต้องไม่ให้ user อื่นบนเครื่องอ่านได้
   */
  function ensure() {
    for (const d of [dir, indexDir]) {
      fs.mkdirSync(d, { recursive: true, mode: DIR_MODE });
      fs.chmodSync(d, DIR_MODE);
    }
    return dir;
  }

  const fileOf = (quoteId) => path.join(dir, `${quoteId}.json`);

  function writeRecord(record) {
    ensure();
    /*
     * เขียนลงไฟล์ชั่วคราวแล้วค่อย rename — rename บน filesystem เดียวกันเป็น atomic
     * ถ้าเครื่องดับกลางคัน จะได้ไม่เหลือใบเสนอราคาที่ JSON ขาดครึ่ง
     */
    const tmp = path.join(dir, `.${record.quote_id}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: FILE_MODE });
    fs.chmodSync(tmp, FILE_MODE);
    fs.renameSync(tmp, fileOf(record.quote_id));
    return record;
  }

  function readRecord(quoteId) {
    try {
      return JSON.parse(fs.readFileSync(fileOf(quoteId), "utf8"));
    } catch {
      return null;
    }
  }

  /*
   * จองหมายเลขใบเสนอราคาแบบชนกันไม่ได้
   * ใช้ open(..., "wx") ซึ่ง "สร้างไฟล์ใหม่เท่านั้น ถ้ามีอยู่แล้วให้ error" — เป็น atomic
   * ระดับ syscall จึงไม่ต้องมีไฟล์ล็อกให้ค้างตอน process ตาย
   * สองข้อความที่เข้ามาพร้อมกัน ตัวที่ช้ากว่าจะได้ EEXIST แล้วขยับไปเลขถัดไปเอง
   */
  function reserveId(date) {
    ensure();
    const day = yyyymmdd(date);
    const prefix = `Q-${day}-`;

    let start = 0;
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
      const n = Number(name.slice(prefix.length, -".json".length));
      if (Number.isInteger(n) && n > start) start = n;
    }

    for (let n = start + 1; n <= 999; n++) {
      const id = prefix + pad3(n);
      try {
        fs.closeSync(fs.openSync(fileOf(id), "wx", FILE_MODE));
        return id;
      } catch (err) {
        if (err.code !== "EEXIST") throw err;
      }
    }
    throw new Error(`ใบเสนอราคาวันที่ ${day} ครบ 999 ใบแล้ว`);
  }

  function linkUser(lineUserId, quoteId) {
    if (!lineUserId) return;
    ensure();
    const file = path.join(indexDir, `${userKey(lineUserId)}.json`);
    let idx;
    try {
      idx = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      idx = { line_user_id: lineUserId, quote_ids: [] };
    }
    if (!idx.quote_ids.includes(quoteId)) idx.quote_ids.push(quoteId);
    fs.writeFileSync(file, `${JSON.stringify(idx, null, 2)}\n`, { mode: FILE_MODE });
    fs.chmodSync(file, FILE_MODE);
  }

  const audit = (record, action, detail, actor = "system") => {
    record.audit.push({ at: now().toISOString(), actor, action, ...detail });
    return record;
  };

  /* ───────── คิดเงิน — จาก products.md เท่านั้น ───────── */

  /*
   * คืน { items, subtotal, discount_amount, net, deposit, problems }
   * problems ไม่ว่าง = มีของที่ไม่อยู่ในตาราง หรือราคายังไม่ระบุ → ห้ามคิดต่อ ต้องส่งต่อคน
   */
  function compute(requested, discountPercent) {
    const list = source();
    const problems = [];
    const items = [];
    let subtotal = 0;

    if (!list.ok) problems.push("อ่านตารางราคาใน products.md ไม่ได้");

    for (const req of requested) {
      const qty = Math.trunc(Number(req.qty) || 0);
      if (qty < 1) {
        problems.push(`จำนวนของ "${req.slug}" ไม่ถูกต้อง`);
        continue;
      }
      const price = priceOf(req.slug, list);
      if (!price) {
        problems.push(`ราคาใน products.md ไม่ครบ: ${req.name ?? req.slug}`);
        continue;
      }
      const lineSatang = price.satang * qty;
      subtotal += lineSatang;
      items.push({
        slug: price.slug,
        name: price.name,
        unit: price.unit,
        qty,
        unit_price: price.satang / 100,
        line_total: lineSatang / 100,
      });
    }

    if (items.length === 0) problems.push("ไม่มีรายการสินค้าที่คิดราคาได้");

    const pct = Number(discountPercent) || 0;
    const discountSatang = Math.round((subtotal * pct) / 100);
    const netSatang = subtotal - discountSatang;
    const depositSatang = Math.round((netSatang * DEPOSIT_PERCENT) / 100);

    return {
      items,
      subtotal: subtotal / 100,
      discount_percent: pct,
      discount_amount: discountSatang / 100,
      net: netSatang / 100,
      deposit: depositSatang / 100,
      deposit_percent: DEPOSIT_PERCENT,
      price_source_checksum: list.checksum,
      problems,
    };
  }

  /*
   * นิยาม "ตรวจแล้ว" — คืน { ok, reasons }
   *   ก. ทุกรายการและราคาตรง products.md
   *   ข. คำนวณยอดใหม่จาก source แล้วตรงกับที่บันทึกไว้ (กันคนไปแก้ไฟล์ด้วยมือ)
   *   ค. ส่วนลดไม่เกินเพดาน
   *   ง. ยอดสุทธิไม่เกินเกณฑ์
   */
  function review(record) {
    const reasons = [];
    const fresh = compute(
      record.items.map((i) => ({ slug: i.slug, qty: i.qty, name: i.name })),
      record.discount_percent,
    );

    reasons.push(...fresh.problems);

    for (const key of ["subtotal", "discount_amount", "net", "deposit"]) {
      if (fresh[key] !== record[key]) {
        reasons.push(`${key} ไม่ตรงกับที่คำนวณใหม่จาก products.md (${record[key]} ≠ ${fresh[key]})`);
      }
    }

    if (record.discount_percent > DISCOUNT_CAP_PERCENT) {
      reasons.push(`ส่วนลด ${record.discount_percent}% เกินเพดาน ${DISCOUNT_CAP_PERCENT}%`);
    }
    if (record.net > HIGH_VALUE_BAHT) {
      reasons.push(`ยอดสุทธิ ${record.net} บาท เกินเกณฑ์ ${HIGH_VALUE_BAHT} บาท`);
    }

    return { ok: reasons.length === 0, reasons };
  }

  /* เปลี่ยนสถานะตามเส้นทางที่อนุญาตเท่านั้น — คืน false ถ้าเส้นทางนั้นไม่มีอยู่จริง */
  function transition(record, to, { actor = "system", note } = {}) {
    const from = record.status;
    if (!FLOW[from]?.includes(to)) return false;
    record.status = to;
    audit(record, "status", { from, to, ...(note ? { note } : {}) }, actor);
    return true;
  }

  /*
   * ใบที่เลยวันหมดอายุต้องกลายเป็น "หมดอายุ" ทันทีที่มีคนแตะ
   * เช็คตอนอ่านแทนที่จะตั้ง cron กวาด — ไม่มีทางมีใบที่ "หมดอายุแล้วแต่ระบบยังไม่รู้"
   * ไปโผล่ในการ์ดหรือไปออก QR ได้
   */
  function expireIfDue(record) {
    if (!record || TERMINAL.has(record.status)) return record;
    if (new Date(record.expires_at).getTime() > now().getTime()) return record;

    const from = record.status;
    record.status = STATUS.EXPIRED;
    audit(record, "status", { from, to: STATUS.EXPIRED, note: "เลยวันหมดอายุ" });
    return writeRecord(record);
  }

  return {
    dir,
    ensure,
    STATUS,
    compute,
    review,

    /*
     * สร้างใบเสนอราคา แล้วตรวจอัตโนมัติทันที
     * ผ่าน → "ตรวจแล้ว" · ไม่ผ่าน → คง "draft" พร้อม reasons ให้ผู้เรียกไปแจ้งแอดมิน
     * requested เป็น [{ slug, qty }] เท่านั้น — ไม่มีช่องให้ส่งราคาเข้ามา โดยตั้งใจ
     */
    create({ lineUserId, chatId, requested, discountPercent = 0, actor = "bot", note } = {}) {
      ensure();
      const at = now();
      const computed = compute(requested ?? [], discountPercent);

      /* ของนอกตาราง / ราคายังไม่ระบุ → ไม่ออกเลขใบให้ด้วยซ้ำ ส่งต่อคนตั้งแต่ต้นทาง */
      if (computed.problems.length > 0) {
        return { quote: null, ok: false, reasons: computed.problems };
      }

      const quoteId = reserveId(at);
      const expires = new Date(at.getTime() + VALID_DAYS * 24 * 60 * 60 * 1000);

      const record = {
        quote_id: quoteId,
        version: 1,
        line_user_id: lineUserId ?? null,
        chat_id: chatId ?? null,
        conversation_suffix: suffixOf(chatId ?? lineUserId),
        items: computed.items,
        subtotal: computed.subtotal,
        discount_percent: computed.discount_percent,
        discount_amount: computed.discount_amount,
        net: computed.net,
        deposit_percent: computed.deposit_percent,
        deposit: computed.deposit,
        created_at: at.toISOString(),
        expires_at: expires.toISOString(),
        status: STATUS.DRAFT,
        approver: null,
        price_source: "products.md",
        price_source_checksum: computed.price_source_checksum,
        previous_versions: [],
        audit: [],
      };

      audit(record, "create", { note: note ?? null, items: record.items.length }, actor);

      const verdict = review(record);
      if (verdict.ok) {
        transition(record, STATUS.REVIEWED, { actor, note: "ตรวจอัตโนมัติผ่าน" });
      } else {
        audit(record, "review-failed", { reasons: verdict.reasons }, actor);
      }

      writeRecord(record);
      linkUser(lineUserId, quoteId);
      return { quote: record, ok: verdict.ok, reasons: verdict.reasons };
    },

    get(quoteId) {
      return expireIfDue(readRecord(quoteId));
    },

    save: writeRecord,

    /* ใบทั้งหมดของลูกค้าคนหนึ่ง — ใหม่สุดก่อน */
    byUser(lineUserId) {
      let idx;
      try {
        idx = JSON.parse(fs.readFileSync(path.join(indexDir, `${userKey(lineUserId)}.json`), "utf8"));
      } catch {
        return [];
      }
      return idx.quote_ids
        .map((id) => expireIfDue(readRecord(id)))
        .filter(Boolean)
        .reverse();
    },

    list({ day } = {}) {
      ensure();
      const prefix = day ? `Q-${day}-` : "Q-";
      return fs
        .readdirSync(dir)
        .filter((n) => n.startsWith(prefix) && n.endsWith(".json"))
        .sort()
        .map((n) => expireIfDue(readRecord(n.slice(0, -".json".length))))
        .filter(Boolean);
    },

    /* อนุมัติโดยเจ้าของร้าน — ใช้ได้เฉพาะใบที่ยังเป็น draft */
    approve(quoteId, approver) {
      const record = this.get(quoteId);
      if (!record) return { ok: false, error: "ไม่พบใบเสนอราคานี้" };
      if (record.status !== STATUS.DRAFT) {
        return { ok: false, error: `ใบนี้สถานะ "${record.status}" อยู่แล้ว อนุมัติซ้ำไม่ได้`, quote: record };
      }

      const verdict = review(record);
      record.approver = approver;
      /*
       * เจ้าของร้านอนุมัติ = ยอมรับข้อยกเว้นด้วยตัวเอง เก็บเหตุผลที่เคยติดไว้ใน audit
       * วันหลังย้อนดูจะรู้ว่าใบนี้ผ่านเพราะคนอนุมัติ ไม่ใช่เพราะเข้าเกณฑ์เอง
       */
      audit(record, "approve", { override: verdict.ok ? null : verdict.reasons }, approver);
      transition(record, STATUS.REVIEWED, { actor: approver, note: "อนุมัติโดยเจ้าของร้าน" });
      writeRecord(record);
      return { ok: true, quote: record };
    },

    reject(quoteId, approver, reason) {
      const record = this.get(quoteId);
      if (!record) return { ok: false, error: "ไม่พบใบเสนอราคานี้" };
      if (TERMINAL.has(record.status)) {
        return { ok: false, error: `ใบนี้สถานะ "${record.status}" แล้ว เปลี่ยนไม่ได้`, quote: record };
      }

      record.approver = approver;
      audit(record, "reject", { reason: reason ?? null }, approver);
      transition(record, STATUS.CANCELLED, { actor: approver, note: reason ?? "ปฏิเสธโดยเจ้าของร้าน" });
      writeRecord(record);
      return { ok: true, quote: record };
    },

    /* เลื่อนสถานะทั่วไป (ส่งลูกค้า / รับสลิปแล้ว / ยืนยันชำระแล้ว) */
    advance(quoteId, to, { actor = "bot", note } = {}) {
      const record = this.get(quoteId);
      if (!record) return { ok: false, error: "ไม่พบใบเสนอราคานี้" };
      if (!transition(record, to, { actor, note })) {
        return { ok: false, error: `เปลี่ยนจาก "${record.status}" เป็น "${to}" ไม่ได้`, quote: record };
      }
      writeRecord(record);
      return { ok: true, quote: record };
    },

    /*
     * เจ้าของร้านตรวจยอดในแอปธนาคารจริงแล้วยืนยัน — จุดเดียวที่ใบกลายเป็น "ยืนยันชำระแล้ว"
     *
     * ═══ ทำไมต้องเป็นคน ═══
     * บอทอ่านสลิปจากรูปไม่ได้ และสลิปปลอมมีจริง (แก้ตัวเลขในภาพใช้เวลาไม่กี่วินาที)
     * "เงินเข้าแล้วจริง" จึงยืนยันได้จากที่เดียวคือแอปธนาคาร ซึ่งมีแต่คนเปิดดูได้
     *
     * ═══ ทำไมปฏิเสธแล้วยังต้องเขียน audit ═══
     * ใบที่ยังไม่ถึง "รับสลิปแล้ว" แต่มีคนพยายามกดยืนยัน คือสัญญาณที่ต้องเห็นย้อนหลังได้
     * ไม่ว่าจะเป็นแอดมินพิมพ์เลขใบผิด หรือมีคนพยายามดันใบให้ผ่านโดยไม่มีเงินเข้า
     * ถ้าปฏิเสธเงียบ ๆ ความพยายามนั้นจะไม่เหลือร่องรอยเลย — สถานะไม่ขยับ แต่ร่องรอยต้องขยับ
     */
    confirmPayment(quoteId, approver) {
      const record = this.get(quoteId);
      if (!record) return { ok: false, error: "ไม่พบใบเสนอราคานี้" };

      if (record.status !== STATUS.SLIP) {
        audit(record, "confirm-rejected", { attempted_from: record.status }, approver);
        writeRecord(record);
        return {
          ok: false,
          error: `ใบนี้สถานะ "${record.status}" ยังไม่ถึงขั้นรับสลิป ยืนยันยอดไม่ได้`,
          quote: record,
        };
      }

      record.approver = approver;
      audit(record, "confirm-payment", { net: record.net, deposit: record.deposit }, approver);
      transition(record, STATUS.PAID, { actor: approver, note: "เจ้าของร้านตรวจยอดในแอปธนาคารแล้ว" });
      writeRecord(record);
      return { ok: true, quote: record };
    },

    /*
     * แก้ใบที่ส่งลูกค้าไปแล้ว — ห้ามทับของเดิม ต้องขึ้น version ใหม่เสมอ
     * เก็บสำเนาเดิมไว้ใน previous_versions เพื่อให้ยอดที่ลูกค้าเคยเห็นยังย้อนดูได้
     * แล้วตรวจใหม่ทั้งใบ (ราคาอาจเปลี่ยนไปแล้วตั้งแต่ครั้งก่อน)
     */
    revise(quoteId, { requested, discountPercent, actor = "bot", reason } = {}) {
      const record = this.get(quoteId);
      if (!record) return { ok: false, error: "ไม่พบใบเสนอราคานี้" };
      if (TERMINAL.has(record.status)) {
        return { ok: false, error: `ใบนี้สถานะ "${record.status}" แล้ว แก้ไม่ได้`, quote: record };
      }

      const nextRequested = requested ?? record.items.map((i) => ({ slug: i.slug, qty: i.qty }));
      const nextDiscount = discountPercent ?? record.discount_percent;
      const computed = compute(nextRequested, nextDiscount);
      if (computed.problems.length > 0) return { ok: false, error: computed.problems.join(" · "), quote: record };

      const snapshot = {
        version: record.version,
        status: record.status,
        items: record.items,
        subtotal: record.subtotal,
        discount_percent: record.discount_percent,
        discount_amount: record.discount_amount,
        net: record.net,
        deposit: record.deposit,
        archived_at: now().toISOString(),
      };

      record.previous_versions.push(snapshot);
      record.version += 1;
      Object.assign(record, {
        items: computed.items,
        subtotal: computed.subtotal,
        discount_percent: computed.discount_percent,
        discount_amount: computed.discount_amount,
        net: computed.net,
        deposit: computed.deposit,
        price_source_checksum: computed.price_source_checksum,
        /* ของเดิมส่งลูกค้าไปแล้ว ยอดใหม่ต้องถูกตรวจใหม่ก่อนส่งซ้ำ จึงถอยกลับเป็น draft */
        status: STATUS.DRAFT,
        approver: null,
      });
      audit(record, "revise", { to_version: record.version, reason: reason ?? null, from_status: snapshot.status }, actor);

      const verdict = review(record);
      if (verdict.ok) transition(record, STATUS.REVIEWED, { actor, note: "ตรวจอัตโนมัติผ่าน (ฉบับแก้ไข)" });
      else audit(record, "review-failed", { reasons: verdict.reasons }, actor);

      writeRecord(record);
      return { ok: verdict.ok, quote: record, reasons: verdict.reasons };
    },
  };
}

/* ───────── กฎการเปิดเผย — ใช้ได้โดยไม่ต้องมี store ───────── */

/* การ์ดใบเสนอราคาส่งได้เฉพาะใบที่ตรวจแล้วขึ้นไป — draft ห้ามส่งเด็ดขาด */
export const canSendQuoteCard = (quote) =>
  Boolean(quote) && [STATUS.REVIEWED, STATUS.SENT, STATUS.SLIP].includes(quote.status);

/*
 * QR ออกได้เฉพาะ "ตรวจแล้ว" กับ "ส่งลูกค้า" — draft / หมดอายุ / ยกเลิก ห้ามออก
 *
 * "รับสลิปแล้ว" ก็ห้ามด้วย ทั้งที่ใบยังไม่ตาย: ลูกค้าโอนมาแล้วและกำลังรอเราตรวจยอด
 * ยื่น QR ใบใหม่ให้ตอนนั้นคือชวนให้โอนซ้ำรอบสอง ซึ่งแก้ยากกว่าการให้รอคำยืนยันอีกนิด
 */
export const canIssueQr = (quote) =>
  Boolean(quote) && [STATUS.REVIEWED, STATUS.SENT].includes(quote.status);

/*
 * สรุปใบเสนอราคาสำหรับ "หน้ารายงาน" และแจ้งเตือนแอดมิน
 * โชว์ได้แค่ suffix 4 ตัว — LINE user id เต็มอยู่ในไฟล์บน VPS เท่านั้น
 * ถ้าใครเอาผลลัพธ์ของฟังก์ชันนี้ไป log หรือไป paste ที่ไหน ก็ไม่มี PII ติดไปด้วย
 */
export function reportLine(quote) {
  if (!quote) return "";
  const items = quote.items.map((i) => `${i.name}×${i.qty}`).join(", ");
  return [
    `${quote.quote_id} [${quote.status}] v${quote.version}`,
    `ห้อง …${quote.conversation_suffix}`,
    items,
    `สุทธิ ${quote.net.toLocaleString("th-TH")} บ. · มัดจำ ${quote.deposit.toLocaleString("th-TH")} บ.`,
  ].join(" · ");
}

/* ตัวกลางที่เซิร์ฟเวอร์ใช้ — เทสต์สร้าง store ของตัวเองชี้ไป temp dir */
export const quoteStore = createQuoteStore();
