/*
 * ที่เก็บรูปที่ลูกค้าส่งเข้ามา + ลิงก์ชั่วคราวให้ LINE มาดึงรูป
 *
 * ═══ ทำไมรูปต้องอยู่บน VPS ไม่ใช่ใน repo ═══
 * รูปที่ลูกค้าส่งมาคือสลิปโอนเงิน ซึ่งมีชื่อผู้โอน เลขบัญชีปลายทาง เวลา และยอด
 * เป็นข้อมูลส่วนบุคคลเต็ม ๆ ตาม PDPA — repo นี้เป็น public จึงห้ามเข้าเด็ดขาด
 * เก็บที่ ~/shop-data/slips/ โฟลเดอร์ 700 ไฟล์ 600 เหมือนใบเสนอราคา
 *
 * ═══ ทำไมต้องมีลิงก์ชั่วคราว ═══
 * โจทย์ต้องการให้เจ้าของร้านเห็น "รูปจริง" ในแชท ไม่ใช่ชื่อไฟล์ — ซึ่งแปลว่า
 * เซิร์ฟเวอร์ของ LINE ต้องเข้ามาดึงรูปได้จาก URL สาธารณะ
 *
 * ตัว LINE ไม่มี session ให้เราตรวจสิทธิ์ ทางเดียวที่เหลือคือทำให้ URL นั้น
 * "เดาไม่ได้ · อายุสั้น · ใช้ได้ไม่กี่ครั้ง":
 *   - id สุ่ม 128 บิต
 *   - token เซ็นด้วย HMAC จากกุญแจที่สุ่มใหม่ทุกครั้งที่บูต (รีสตาร์ต = ลิงก์เก่าตายหมด)
 *   - หมดอายุใน 5 นาที
 *   - ดึงได้สูงสุด 4 ครั้ง (LINE ดึง originalContentUrl กับ previewImageUrl แยกกัน
 *     และอาจ retry) ครบแล้วปิดทันทีโดยไม่ต้องรอหมดอายุ
 *
 * ไฟล์ต้นฉบับยังอยู่บน VPS หลัง token ตาย และไม่มีหน้า listing ให้ไล่ดูทั้งโฟลเดอร์
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/* อายุลิงก์ — สั้นพอที่ลิงก์หลุดไปแล้วก็ตายก่อนใครเอาไปใช้ทัน */
export const TOKEN_TTL_MS = 5 * 60 * 1000;

/* ดึงได้กี่ครั้งก่อนปิด */
export const MAX_FETCHES = 4;

/* เก็บรูปกี่วันก่อนลบอัตโนมัติ (นโยบายร้าน) */
export const RETENTION_DAYS = 30;

export const slipsDir = () =>
  process.env.SHOP_DATA_DIR
    ? path.join(process.env.SHOP_DATA_DIR, "slips")
    : path.join(os.homedir(), "shop-data", "slips");

/* ชนิดไฟล์ที่รับ — ดูจากไบต์จริง ไม่เชื่อสิ่งที่ผู้ส่งบอก */
function sniff(buffer) {
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { ext: "jpg", type: "image/jpeg" };
  }
  if (buffer.length > 8 && buffer.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") {
    return { ext: "png", type: "image/png" };
  }
  return null;
}

export function createMediaStore({ dir = slipsDir(), now = () => new Date() } = {}) {
  /*
   * กุญแจเซ็น token — สุ่มใหม่ทุกครั้งที่ process เริ่ม และอยู่ในหน่วยความจำเท่านั้น
   * ผลข้างเคียงที่ตั้งใจ: deploy ใหม่ทีไร ลิงก์รูปที่ค้างอยู่ตายหมดทันที
   */
  const signingKey = crypto.randomBytes(32);

  /* id -> จำนวนครั้งที่ถูกดึงไปแล้ว (อยู่ในหน่วยความจำ ไม่ต้องคงอยู่ข้ามรีสตาร์ต) */
  const fetches = new Map();
  const revoked = new Set();

  const ensure = () => {
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    fs.chmodSync(dir, DIR_MODE);
    return dir;
  };

  const metaOf = (id) => path.join(dir, `${id}.json`);
  const fileOf = (id, ext) => path.join(dir, `${id}.${ext}`);

  const readMeta = (id) => {
    try {
      return JSON.parse(fs.readFileSync(metaOf(id), "utf8"));
    } catch {
      return null;
    }
  };

  const sign = (id, expires) =>
    crypto.createHmac("sha256", signingKey).update(`${id}.${expires}`).digest("base64url");

  return {
    dir,
    ensure,

    /*
     * เก็บรูป — คืน { id, ext, type, bytes } หรือ null ถ้าไม่ใช่รูปที่รับได้
     *
     * metadata เก็บเท่าที่ต้องใช้จริง: ห้องไหน (suffix 4 ตัว) เมื่อไหร่ ผูกกับใบไหน
     * ไม่เก็บ LINE user id เต็ม ไม่เก็บ messageId ของ LINE (ย้อนกลับไปหาคนส่งได้)
     */
    save(buffer, { chatSuffix = "????", quoteId = null, state = "unmatched" } = {}) {
      const kind = sniff(buffer);
      if (!kind) return null;

      ensure();
      const id = crypto.randomBytes(16).toString("hex");
      fs.writeFileSync(fileOf(id, kind.ext), buffer, { mode: FILE_MODE });
      fs.chmodSync(fileOf(id, kind.ext), FILE_MODE);

      const meta = {
        id,
        ext: kind.ext,
        type: kind.type,
        bytes: buffer.length,
        saved_at: now().toISOString(),
        chat_suffix: chatSuffix,
        quote_id: quoteId,
        state,
      };
      fs.writeFileSync(metaOf(id), `${JSON.stringify(meta, null, 2)}\n`, { mode: FILE_MODE });
      fs.chmodSync(metaOf(id), FILE_MODE);
      return meta;
    },

    meta: readMeta,

    /* ผูกรูปกับใบเสนอราคาทีหลัง (ตอนลูกค้าตอบยืนยันว่าใบไหน) */
    link(id, { quoteId, state }) {
      const meta = readMeta(id);
      if (!meta) return null;
      const next = { ...meta, quote_id: quoteId ?? meta.quote_id, state: state ?? meta.state };
      fs.writeFileSync(metaOf(id), `${JSON.stringify(next, null, 2)}\n`, { mode: FILE_MODE });
      return next;
    },

    /* สร้าง path+query ที่เซ็นแล้ว — ผู้เรียกเอาไปต่อกับ PUBLIC_BASE_URL เอง */
    signedPath(id, { ttlMs = TOKEN_TTL_MS } = {}) {
      const meta = readMeta(id);
      if (!meta) return null;
      const expires = now().getTime() + ttlMs;
      fetches.set(id, 0);
      revoked.delete(id);
      return `/media/${id}.${meta.ext}?e=${expires}&s=${sign(id, expires)}`;
    },

    /*
     * ตรวจคำขอที่เข้ามาจริง — คืน { ok, file, type } หรือ { ok:false, reason }
     * นับจำนวนครั้งที่ถูกดึง พอครบเพดานก็ปิดเลย ไม่ต้องรอหมดอายุ
     */
    resolve(id, { expires, signature } = {}) {
      if (revoked.has(id)) return { ok: false, reason: "revoked" };

      const exp = Number(expires);
      if (!Number.isFinite(exp) || exp <= now().getTime()) return { ok: false, reason: "expired" };

      const expected = sign(id, expires);
      const a = Buffer.from(String(signature ?? ""), "utf8");
      const b = Buffer.from(expected, "utf8");
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: "bad-signature" };

      const meta = readMeta(id);
      if (!meta) return { ok: false, reason: "not-found" };

      const used = (fetches.get(id) ?? 0) + 1;
      fetches.set(id, used);
      if (used > MAX_FETCHES) {
        revoked.add(id);
        return { ok: false, reason: "used-up" };
      }
      if (used === MAX_FETCHES) revoked.add(id);

      return { ok: true, file: fileOf(id, meta.ext), type: meta.type };
    },

    /* ปิดลิงก์ทันที — เรียกหลังส่งเสร็จถ้าไม่อยากรอเพดานการดึง */
    revoke(id) {
      revoked.add(id);
    },

    /* ลบรูปที่เกิน retention — เรียกตอนบูตและตอนรายงานเย็นทำงาน */
    sweep({ days = RETENTION_DAYS } = {}) {
      const cutoff = now().getTime() - days * 24 * 60 * 60 * 1000;
      let removed = 0;
      let files;
      try {
        files = fs.readdirSync(dir);
      } catch {
        return 0;
      }

      for (const name of files) {
        if (!name.endsWith(".json")) continue;
        const id = name.slice(0, -".json".length);
        const meta = readMeta(id);
        if (!meta || new Date(meta.saved_at).getTime() >= cutoff) continue;
        for (const f of [metaOf(id), fileOf(id, meta.ext)]) {
          try {
            fs.unlinkSync(f);
          } catch {
            /* หายไปแล้ว */
          }
        }
        removed++;
      }
      return removed;
    },
  };
}

/*
 * อ่าน stream ที่ LINE ส่งกลับมาเป็น Buffer พร้อมเพดานขนาด
 * ไม่มีเพดาน = ใครส่งไฟล์ใหญ่ ๆ เข้ามาก็กินแรมเราได้ฟรี ๆ
 */
export async function readStream(stream, { maxBytes = 12 * 1024 * 1024 } = {}) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > maxBytes) throw new RangeError(`ไฟล์ใหญ่เกิน ${Math.round(maxBytes / 1024 / 1024)} MB`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
